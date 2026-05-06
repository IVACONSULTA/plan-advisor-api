const express = require("express");
const router = express.Router();
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const db = require("../lib/db");
const { requireAuth } = require("../lib/supabase");
const { checkAIQuota, logAIUsage } = require("../lib/quota");

/** Debug logs (always on; omit large payloads and secrets). */
function logSummary(event, detail = {}) {
  const safe = { ...detail };
  if (safe.agentUrl) {
    try {
      const u = new URL(safe.agentUrl);
      safe.agentUrl = `${u.origin}${u.pathname}`;
    } catch {
      delete safe.agentUrl;
    }
  }
  console.log("[ai-summary]", event, safe);
}

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many summary requests. Please wait a minute." },
});

/** Flat `{ input_key: volume }` for the summary agent (legacy `input_json` or nested `{ inputs }`). */
function volumeMapFromScenarioInputJson(inputJson) {
  if (!inputJson || typeof inputJson !== "object") return {};
  if (
    inputJson.inputs &&
    typeof inputJson.inputs === "object" &&
    !Array.isArray(inputJson.inputs)
  ) {
    return inputJson.inputs;
  }
  return inputJson;
}

/** Axios often puts syscall errors on `err.cause` (Node 18+). */
function axiosNetworkCode(err) {
  if (!err || typeof err !== "object") return null;
  const c = err.cause;
  if (c && typeof c === "object" && typeof c.code === "string") return c.code;
  if (typeof err.code === "string") return err.code;
  const msg = String(err.message || "");
  if (msg.includes("ENOTFOUND")) return "ENOTFOUND";
  if (msg.includes("ECONNREFUSED")) return "ECONNREFUSED";
  if (msg.includes("ETIMEDOUT")) return "ETIMEDOUT";
  return null;
}

/** JSON for client + logs when the summary agent cannot be reached (DNS, TCP, timeout). */
function summaryAgentNetworkPayload(err, reqUrl) {
  const code = axiosNetworkCode(err);
  let hostname = "";
  try {
    if (reqUrl) hostname = new URL(reqUrl).hostname;
  } catch {
    /* ignore */
  }
  const internalRailway = hostname.endsWith(".railway.internal");
  let hint =
    "Verify SUMMARY_AGENT_URL and that the summary agent is running.";

  if (code === "ENOTFOUND" && internalRailway) {
    hint =
      "Hostnames ending in .railway.internal only resolve inside Railway's private network. " +
      "If this API runs outside Railway (e.g. on your laptop), set SUMMARY_AGENT_URL to the agent's public HTTPS URL. " +
      "If the API is on Railway, confirm the private hostname matches your summary service in the Railway dashboard.";
  } else if (code === "ENOTFOUND") {
    hint =
      "DNS lookup failed — check the hostname in SUMMARY_AGENT_URL and your network.";
  } else if (code === "ECONNREFUSED") {
    hint =
      "Connection refused — wrong port, or the summary agent process is not listening.";
  } else if (code === "ETIMEDOUT" || code === "ECONNABORTED") {
    hint =
      "Request timed out — agent may be cold, overloaded, or blocked between networks.";
  }

  return {
    error: "summary_agent_unreachable",
    message: "Could not reach the summary agent.",
    code,
    hint,
  };
}

/**
 * POST /api/scenarios/:id/generate-summary
 * Admin / Internal / Client (if enabled) — call the Summary Agent (App 4).
 * No recalculation — only passes the saved result to the agent.
 */
router.post(
  "/:id/generate-summary",
  requireAuth,
  checkAIQuota,
  aiLimiter,
  async (req, res) => {
    const { id } = req.params;

    if (!process.env.SUMMARY_AGENT_URL) {
      logSummary("503 summary_agent_unavailable", { scenarioId: id });
      return res.status(503).json({
        error: "summary_agent_unavailable",
        message:
          "SUMMARY_AGENT_URL is not set. Configure the summary agent URL in Railway (see docs/PA-PLAN-ADVISOR-GUIDE.md).",
      });
    }
    const agentApiKey = String(
      process.env.AGENT_API_KEY || process.env.SUMMARY_AGENT_API_KEY || "",
    ).trim();
    if (!agentApiKey) {
      logSummary("503 summary_agent_misconfigured", { scenarioId: id });
      return res.status(503).json({
        error: "summary_agent_misconfigured",
        message:
          "AGENT_API_KEY is not set (or use legacy SUMMARY_AGENT_API_KEY). Must match the summary service X-API-Key. See .env.example.",
      });
    }

    logSummary("request", {
      scenarioId: id,
      userId: req.user?.id,
      userRole: req.userRole,
    });

    try {
      // 1. Fetch the scenario
      const { rows } = await db.query(
        `SELECT s.*,
                cp.version AS profile_version,
                cp.currency,
                co.name AS country_name,
                pr.name AS provider_name,
                creator.role AS created_by_role
         FROM scenarios s
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co            ON co.id = cp.country_id
         JOIN providers pr            ON pr.id = cp.provider_id
         JOIN users_profile creator  ON creator.id = s.created_by
         WHERE s.id = $1`,
        [id],
      );

      if (!rows.length) {
        logSummary("404 scenario_not_found", { scenarioId: id });
        return res.status(404).json({ error: "Scenario not found." });
      }

      const scenario = rows[0];

      logSummary("scenario_loaded", {
        scenarioId: id,
        profileId: scenario.profile_id,
        country: scenario.country_name,
        provider: scenario.provider_name,
        profileVersion: scenario.profile_version,
        createdByRole: scenario.created_by_role,
        hasResultJson: !!scenario.result_json,
        inputKeysCount: Object.keys(
          volumeMapFromScenarioInputJson(scenario.input_json),
        ).length,
      });

      if (req.userRole === "internal") {
        if (!["admin", "internal"].includes(scenario.created_by_role)) {
          logSummary("403 internal_creator_role", {
            scenarioId: id,
            createdByRole: scenario.created_by_role,
          });
          return res.status(403).json({ error: "Access denied." });
        }
      }

      // Access control — client can only summarise own/company scenarios
      if (req.userRole === "client") {
        const { rows: up } = await db.query(
          `SELECT company_id FROM users_profile WHERE id = $1`,
          [req.user.id],
        );
        const ownScenario = scenario.created_by === req.user.id;
        const sameCompany =
          up[0]?.company_id && scenario.company_id === up[0].company_id;
        if (!ownScenario && !sameCompany) {
          logSummary("403 client_not_owner_same_company", {
            scenarioId: id,
            ownScenario,
            sameCompany: !!sameCompany,
            userCompanyId: up[0]?.company_id ?? null,
            scenarioCompanyId: scenario.company_id ?? null,
          });
          return res.status(403).json({ error: "Access denied." });
        }
      }

      const result = scenario.result_json;

      const rawInputJson = scenario.input_json;
      const inputsForAgent = volumeMapFromScenarioInputJson(rawInputJson);

      const agentUrl = `${process.env.SUMMARY_AGENT_URL}/generate-summary`;
      const t0 = Date.now();
      logSummary("agent_call_start", {
        scenarioId: id,
        agentUrl,
        timeoutMs: 60_000,
        volumeKeys: Object.keys(inputsForAgent).length,
        hasCalculatorForm: !!(
          rawInputJson &&
          typeof rawInputJson === "object" &&
          rawInputJson.calculator_form
        ),
        hasTransactionBreakdown: !!result?.transaction_breakdown,
        hasPlanComparison: !!result?.plan_comparison,
      });

      // 2. Call Summary Agent (App 4) via internal Railway network
      const { data: agentResponse } = await axios.post(
        agentUrl,
        {
          country: scenario.country_name,
          provider: scenario.provider_name,
          profile_version: scenario.profile_version,
          inputs: inputsForAgent,
          ...(rawInputJson &&
          typeof rawInputJson === "object" &&
          rawInputJson.calculator_form
            ? { calculator_form: rawInputJson.calculator_form }
            : {}),
          transaction_breakdown: result.transaction_breakdown,
          plan_comparison: result.plan_comparison,
          recommended_plan: result.recommended_plan,
          assumptions: result.assumptions || [],
        },
        {
          headers: { "X-API-Key": agentApiKey },
          timeout: 60_000,
        },
      );

      const elapsedMs = Date.now() - t0;
      logSummary("agent_call_ok", {
        scenarioId: id,
        elapsedMs,
        summaryLength:
          typeof agentResponse?.summary === "string"
            ? agentResponse.summary.length
            : null,
        usage: agentResponse?.usage ?? null,
      });

      const summary = agentResponse.summary;

      // 3. Persist the summary
      await db.query(`UPDATE scenarios SET ai_summary = $1 WHERE id = $2`, [
        summary,
        id,
      ]);
      logSummary("db_updated_ai_summary", { scenarioId: id });

      // 4. Log AI usage
      await logAIUsage({
        userId: req.user.id,
        action: "generate_summary",
        model: "dspy",
        scenarioId: id,
        inputTokens: agentResponse.usage?.input_tokens || null,
        outputTokens: agentResponse.usage?.output_tokens || null,
        estimatedCost: agentResponse.usage?.estimated_cost || null,
      });

      logSummary("response_ok", { scenarioId: id });
      res.json({ summary });
    } catch (err) {
      if (err.response) {
        logSummary("agent_http_error", {
          scenarioId: id,
          status: err.response.status,
          statusText: err.response.statusText,
          data:
            typeof err.response.data === "object"
              ? err.response.data
              : String(err.response.data).slice(0, 500),
        });
        return res.status(err.response.status).json(err.response.data);
      }
      const netCode = err.isAxiosError ? axiosNetworkCode(err) : null;
      const unreachableCodes = new Set([
        "ENOTFOUND",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ECONNABORTED",
        "EAI_AGAIN",
      ]);
      if (err.isAxiosError && netCode && unreachableCodes.has(netCode)) {
        const body = summaryAgentNetworkPayload(err, err.config?.url);
        logSummary("agent_network_error", { scenarioId: id, ...body });
        console.error("[ai-summary] stack", err);
        return res.status(503).json(body);
      }
      const code = err.code || null;
      logSummary("error", {
        scenarioId: id,
        message: err.message,
        code,
        isAxiosError: err.isAxiosError === true,
      });
      console.error("[ai-summary] stack", err);
      res.status(500).json({ error: "Failed to generate summary." });
    }
  },
);

module.exports = router;
