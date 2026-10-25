\set ON_ERROR_STOP on
\pset pager off
\if :{?expected_database}
\else
  DO $error$ BEGIN RAISE EXCEPTION 'expected_database is required'; END $error$;
\endif
\if :{?application_role}
\else
  DO $error$ BEGIN RAISE EXCEPTION 'application_role is required'; END $error$;
\endif
\if :{?apply}
\else
  \set apply false
\endif
\if :{?commit}
\else
  \set commit false
\endif

\if :apply
  \if :{?authorization}
    SELECT :'authorization' = 'REVOKE_PUBLIC_CREATE' AS authorized \gset
    \if :authorized
    \else
      DO $error$ BEGIN RAISE EXCEPTION 'explicit human authorization is required'; END $error$;
    \endif
  \else
    DO $error$ BEGIN RAISE EXCEPTION 'explicit human authorization is required'; END $error$;
  \endif
  BEGIN ISOLATION LEVEL REPEATABLE READ;
\else
  BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\endif
SET LOCAL search_path TO pg_catalog;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';
SELECT set_config('crewrouter.review_application_role', :'application_role', true),
       set_config('crewrouter.review_expected_database', :'expected_database', true);

DO $review$
BEGIN
  IF current_database() <> current_setting('crewrouter.review_expected_database') THEN
    RAISE EXCEPTION 'Database does not match expected_database';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = current_setting('crewrouter.review_application_role')) THEN
    RAISE EXCEPTION 'Application role does not exist';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'public') THEN
    RAISE EXCEPTION 'public schema does not exist';
  END IF;
END
$review$;

SELECT current_database() AS database, session_user AS operator, current_user AS execution_role,
       current_setting('transaction_read_only') AS read_only,
       pg_get_userbyid(namespace.nspowner) AS schema_owner,
       pg_get_userbyid(database.datdba) AS database_owner, namespace.nspacl::text AS original_schema_acl
FROM pg_namespace namespace CROSS JOIN pg_database database
WHERE namespace.nspname = 'public' AND database.datname = current_database();

SELECT role.rolname, role.rolsuper, role.rolcreaterole, role.rolcreatedb,
       role.rolreplication, role.rolbypassrls,
       pg_has_role(current_setting('crewrouter.review_application_role'), role.oid, 'USAGE') AS inherited,
       has_schema_privilege(role.oid, 'public', 'CREATE') AS effective_public_create
FROM pg_roles role
WHERE pg_has_role(current_setting('crewrouter.review_application_role'), role.oid, 'MEMBER')
ORDER BY role.rolname;

\if :apply
  DO $revoke$
  DECLARE
    application_name text := current_setting('crewrouter.review_application_role');
  BEGIN
    IF EXISTS(SELECT 1 FROM pg_namespace namespace CROSS JOIN pg_database database
      WHERE namespace.nspname = 'public' AND database.datname = current_database()
        AND (pg_has_role(application_name, namespace.nspowner, 'MEMBER')
          OR pg_has_role(application_name, database.datdba, 'MEMBER'))) THEN
      RAISE EXCEPTION 'BLOCKER: application role can assume schema or database ownership; separate runtime role first';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles role
      WHERE pg_has_role(application_name, role.oid, 'MEMBER')
        AND (role.rolsuper OR role.rolcreaterole OR role.rolcreatedb OR role.rolreplication OR role.rolbypassrls)) THEN
      RAISE EXCEPTION 'BLOCKER: application role or membership has elevated role attributes; separate runtime role first';
    END IF;
    EXECUTE 'REVOKE CREATE ON SCHEMA public FROM PUBLIC';
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', application_name);
    IF has_schema_privilege(application_name, 'public', 'CREATE')
      OR EXISTS(SELECT 1 FROM pg_roles role
        WHERE role.rolname <> application_name
          AND pg_has_role(application_name, role.oid, 'MEMBER')
          AND has_schema_privilege(role.oid, 'public', 'CREATE')) THEN
      RAISE EXCEPTION 'BLOCKER: CREATE remains through ownership or membership; transaction must roll back';
    END IF;
  END
  $revoke$;

  SELECT current_setting('crewrouter.review_application_role') AS application_role,
         has_schema_privilege(current_setting('crewrouter.review_application_role'), 'public', 'CREATE') AS remaining_create,
         has_schema_privilege(current_setting('crewrouter.review_application_role'), 'public', 'USAGE') AS remaining_usage;
  \if :commit
    COMMIT;
    \echo 'APPLIED: reviewed PUBLIC and application-role CREATE revocations committed'
  \else
    ROLLBACK;
    \echo 'PREVIEW ONLY: all revocations rolled back'
  \endif
\else
  ROLLBACK;
  \echo 'READ ONLY: inspected ownership, ACL and role memberships; no revocations executed'
\endif
