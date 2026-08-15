-- 分片回填：仅检查 messages 前 3 条 content（jsonb 路径），避免 messages::text 全量序列化
\echo batch :lo - :hi

-- UA
UPDATE usage_records SET request_source = 'claude_code'
 WHERE id >= :lo AND id < :hi
   AND COALESCE(request_source, 'unknown') IN ('', 'unknown')
   AND user_agent ~* '(claude-cli|claude-code)/';

UPDATE usage_records SET request_source = 'codex'
 WHERE id >= :lo AND id < :hi
   AND COALESCE(request_source, 'unknown') IN ('', 'unknown')
   AND user_agent ~* '(codex_cli_rs|codex-cli|codex_vscode)/';

UPDATE usage_records SET request_source = 'qwen_code'
 WHERE id >= :lo AND id < :hi
   AND COALESCE(request_source, 'unknown') IN ('', 'unknown')
   AND user_agent ~* 'QwenCode/|qwen-code';

UPDATE usage_records SET request_source = 'hermes'
 WHERE id >= :lo AND id < :hi
   AND COALESCE(request_source, 'unknown') IN ('', 'unknown')
   AND user_agent ~* 'hermes-cli/|HermesAgent/|HermesDashboard/';

UPDATE usage_records SET request_source = 'opencode'
 WHERE id >= :lo AND id < :hi
   AND COALESCE(request_source, 'unknown') IN ('', 'unknown')
   AND user_agent ~* 'opencode/';

UPDATE usage_records SET request_source = 'openclaw'
 WHERE id >= :lo AND id < :hi
   AND COALESCE(request_source, 'unknown') IN ('', 'unknown')
   AND user_agent ~* 'openclaw(/| )';

UPDATE usage_records SET request_source = 'grok'
 WHERE id >= :lo AND id < :hi
   AND COALESCE(request_source, 'unknown') IN ('', 'unknown')
   AND user_agent ~* 'grok-shell/|xai-grok';

-- 提示词：只取前 3 条 message 的文本 content
UPDATE usage_records u SET request_source = 'claude_code'
WHERE u.id >= :lo AND u.id < :hi
  AND COALESCE(u.request_source, 'unknown') IN ('', 'unknown')
  AND u.messages IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 3
      AND (
        COALESCE(e->>'content','') ILIKE '%You are Claude Code, Anthropic%'
        OR COALESCE(e->>'content','') ILIKE '%Claude Agent SDK%'
        OR COALESCE(e->>'content','') ILIKE '%You are an agent for Claude Code%'
      )
  );

UPDATE usage_records u SET request_source = 'codex'
WHERE u.id >= :lo AND u.id < :hi
  AND COALESCE(u.request_source, 'unknown') IN ('', 'unknown')
  AND u.messages IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 3
      AND (
        COALESCE(e->>'content','') ILIKE '%coding agent running in the Codex CLI%'
        OR COALESCE(e->>'content','') ILIKE '%Codex CLI is an open source project led by OpenAI%'
        OR COALESCE(e->>'content','') ILIKE '%You are Codex, an OpenAI general-purpose%'
      )
  );

UPDATE usage_records u SET request_source = 'qwen_code'
WHERE u.id >= :lo AND u.id < :hi
  AND COALESCE(u.request_source, 'unknown') IN ('', 'unknown')
  AND u.messages IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 3
      AND COALESCE(e->>'content','') ILIKE '%You are Qwen Code,%'
  );

UPDATE usage_records u SET request_source = 'hermes'
WHERE u.id >= :lo AND u.id < :hi
  AND COALESCE(u.request_source, 'unknown') IN ('', 'unknown')
  AND u.messages IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 3
      AND (
        COALESCE(e->>'content','') ILIKE '%You are Hermes Agent%'
        OR COALESCE(e->>'content','') ILIKE '%Nous Research%'
        OR COALESCE(e->>'content','') ILIKE '%Active Hermes profile:%'
        OR COALESCE(e->>'content','') ILIKE '%security reviewer for an AI coding agent%'
        OR COALESCE(e->>'content','') ILIKE '%hermes-agent.nousresearch.com%'
      )
  );

UPDATE usage_records u SET request_source = 'opencode'
WHERE u.id >= :lo AND u.id < :hi
  AND COALESCE(u.request_source, 'unknown') IN ('', 'unknown')
  AND u.messages IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 3
      AND (
        COALESCE(e->>'content','') ILIKE '%You are opencode, an interactive CLI tool%'
        OR COALESCE(e->>'content','') ILIKE '%You are OpenCode, the best coding agent%'
        OR COALESCE(e->>'content','') ILIKE '%anomalyco/opencode%'
        OR COALESCE(e->>'content','') ILIKE '%The exact model ID is %/%'
      )
  );

UPDATE usage_records u SET request_source = 'openclaw'
WHERE u.id >= :lo AND u.id < :hi
  AND COALESCE(u.request_source, 'unknown') IN ('', 'unknown')
  AND u.messages IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 3
      AND (
        COALESCE(e->>'content','') ILIKE '%running inside OpenClaw%'
        OR COALESCE(e->>'content','') ILIKE '%# SOUL.md - Who You Are%'
        OR COALESCE(e->>'content','') ILIKE '%You''re not a chatbot. You''re becoming someone.%'
        OR COALESCE(e->>'content','') ILIKE '%## OpenClaw Control%'
        OR COALESCE(e->>'content','') ILIKE '%OpenClaw%'
      )
  );

UPDATE usage_records u SET request_source = 'grok'
WHERE u.id >= :lo AND u.id < :hi
  AND COALESCE(u.request_source, 'unknown') IN ('', 'unknown')
  AND u.messages IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.messages) = 'array' THEN u.messages ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE ord <= 3
      AND (
        COALESCE(e->>'content','') ILIKE '%xAI Grok Build harness%'
        OR COALESCE(e->>'content','') ILIKE '%Grok Build harness%'
      )
  );
