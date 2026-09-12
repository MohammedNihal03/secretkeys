/**
 * The SQL the collector runs, and nothing else.
 *
 * Kept in one file so the entire footprint on a customer's database can be
 * reviewed at a glance -- which is the point of a monitoring tool asking for a
 * role on someone's production server. Every statement is a read of a catalogue
 * or a statistics view; none touches user tables, and the session is read-only
 * besides.
 *
 * Compatibility: everything here exists in PostgreSQL 12 and later. Columns
 * added in newer versions are deliberately not used, so a collection against an
 * older server degrades to fewer metrics rather than to an error.
 */

/**
 * Server identity and what the monitoring role may see.
 *
 * `pg_monitor` is looked up through `pg_roles` rather than by name, because
 * `pg_has_role(current_user, 'pg_monitor', 'member')` raises an error on a
 * server where the role does not exist, and a missing role must read as "not a
 * member", never as a failed collection.
 */
export const SERVER_INFO_SQL = `
  select
    current_setting('server_version') as server_version,
    current_setting('max_connections')::int as max_connections,
    current_setting('superuser_reserved_connections')::int as reserved_connections,
    current_database() as database_name,
    pg_is_in_recovery() as in_recovery,
    extract(epoch from (now() - pg_postmaster_start_time()))::float8 as uptime_seconds,
    coalesce((select rolsuper from pg_roles where rolname = current_user), false) as is_superuser,
    coalesce(
      (select pg_has_role(current_user, oid, 'member') from pg_roles where rolname = 'pg_monitor'),
      false
    ) as has_pg_monitor,
    coalesce(
      (select pg_has_role(current_user, oid, 'member')
       from pg_roles where rolname = 'pg_read_all_stats'),
      false
    ) as has_read_all_stats,
    exists(select 1 from pg_extension where extname = 'pg_stat_statements')
      as has_statement_stats
`;

export interface ServerInfoRow {
  server_version: string;
  max_connections: number;
  reserved_connections: number;
  database_name: string;
  in_recovery: boolean;
  uptime_seconds: number;
  is_superuser: boolean;
  has_pg_monitor: boolean;
  has_read_all_stats: boolean;
  has_statement_stats: boolean;
}

/**
 * Sizes.
 *
 * The cluster total is summed over `pg_database` and skips databases this role
 * cannot connect to, because `pg_database_size` raises on those. A partial
 * total is still useful; an error instead of every other metric is not.
 */
export const SIZE_SQL = `
  select
    pg_database_size(current_database())::float8 as database_size_bytes,
    (
      select sum(pg_database_size(d.oid))::float8
      from pg_database d
      where d.datallowconn and has_database_privilege(d.oid, 'CONNECT')
    ) as cluster_size_bytes
`;

export interface SizeRow {
  database_size_bytes: number;
  cluster_size_bytes: number | null;
}

/**
 * Connections, counted the way `max_connections` counts them.
 *
 * Only `client backend` rows: autovacuum workers, the walwriter and other
 * background processes appear in `pg_stat_activity` but do not consume the
 * slots `max_connections` caps, so including them would overstate utilization.
 *
 * `hidden` is how many client backends this role can see but not describe --
 * without `pg_monitor`, other users' `state` and `query` read as null. It is
 * what makes "3 idle connections" distinguishable from "3 connections I am not
 * allowed to look at".
 */
export const CONNECTIONS_SQL = `
  select
    count(*) filter (where backend_type = 'client backend')::int as total,
    count(*) filter (where backend_type = 'client backend' and state = 'active')::int as active,
    count(*) filter (where backend_type = 'client backend' and state = 'idle')::int as idle,
    count(*) filter (
      where backend_type = 'client backend'
        and state in ('idle in transaction', 'idle in transaction (aborted)')
    )::int as idle_in_transaction,
    count(*) filter (
      where backend_type = 'client backend' and datname = current_database()
    )::int as on_this_database,
    count(*) filter (
      where backend_type = 'client backend' and state is null
    )::int as hidden
  from pg_stat_activity
`;

export interface ConnectionsRow {
  total: number;
  active: number;
  idle: number;
  idle_in_transaction: number;
  on_this_database: number;
  hidden: number;
}

/**
 * What is running right now.
 *
 * The collector excludes its own backend. Counting the monitoring query as an
 * active query would mean every collection reported at least one, and a
 * dashboard that always shows "1 active query" teaches people to ignore it.
 *
 * Scoped to the current database: a target is a database, and another
 * database's workload is not this target's.
 */
export const ACTIVITY_SQL = `
  select
    count(*) filter (where state = 'active')::int as active,
    count(*) filter (
      where state = 'active' and query_start is not null
        and now() - query_start > make_interval(secs => $1::float8)
    )::int as slow,
    count(*) filter (
      where state = 'active' and query_start is not null
        and now() - query_start > make_interval(secs => $2::float8)
    )::int as long_running,
    coalesce(
      max(extract(epoch from (now() - query_start))) filter (where state = 'active'),
      0
    )::float8 as longest_running_seconds,
    count(*) filter (where wait_event_type = 'Lock')::int as blocked
  from pg_stat_activity
  where backend_type = 'client backend'
    and datname = current_database()
    and pid <> pg_backend_pid()
`;

export interface ActivityRow {
  active: number;
  slow: number;
  long_running: number;
  longest_running_seconds: number;
  blocked: number;
}

/** Lock requests that have not been granted: the shape of contention. */
export const LOCKS_SQL = `
  select
    count(*) filter (where not granted)::int as waiting,
    count(*)::int as total
  from pg_locks
  where database is null or database = (select oid from pg_database where datname = current_database())
`;

export interface LocksRow {
  waiting: number;
  total: number;
}

/**
 * The cumulative counters, which every rate in this module is derived from.
 *
 * `stats_reset` comes back with them on purpose: a delta computed across a
 * reset is not a rate, it is a negative number dressed up as one.
 */
export const DATABASE_STATS_SQL = `
  select
    xact_commit::float8 as xact_commit,
    xact_rollback::float8 as xact_rollback,
    blks_read::float8 as blks_read,
    blks_hit::float8 as blks_hit,
    deadlocks::float8 as deadlocks,
    conflicts::float8 as conflicts,
    temp_files::float8 as temp_files,
    temp_bytes::float8 as temp_bytes,
    numbackends::int as numbackends,
    stats_reset
  from pg_stat_database
  where datname = current_database()
`;

export interface DatabaseStatsRow {
  xact_commit: number;
  xact_rollback: number;
  blks_read: number;
  blks_hit: number;
  deadlocks: number;
  conflicts: number;
  temp_files: number;
  temp_bytes: number;
  numbackends: number;
  stats_reset: Date | null;
}

/** The minimum grants a monitoring role needs, shown to operators verbatim. */
export const MONITORING_ROLE_SQL = `CREATE ROLE observability LOGIN PASSWORD 'a-strong-password';
GRANT pg_monitor TO observability;
GRANT CONNECT ON DATABASE your_database TO observability;`;
