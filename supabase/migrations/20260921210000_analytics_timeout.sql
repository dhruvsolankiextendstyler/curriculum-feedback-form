-- Statement timeout for analytics RPCs.
--
-- Prevents any single analytics query from holding a connection pool slot
-- longer than 10 seconds. At scale the connection pool is the bottleneck,
-- and one admin's unfiltered heatmap on a 500k-row table should not starve
-- respondents trying to submit feedback.
--
-- Safe to run on a live database: ALTER FUNCTION is transactional and the
-- rollback block reverses each change.

-- The 8 analytics RPCs that do heavy aggregation:
alter function analytics_totals             set statement_timeout = '10s';
alter function analytics_question_stats     set statement_timeout = '10s';
alter function analytics_distribution       set statement_timeout = '10s';
alter function analytics_choice_distribution set statement_timeout = '10s';
alter function analytics_trends             set statement_timeout = '10s';
alter function analytics_text_answers       set statement_timeout = '10s';
alter function analytics_export_rows        set statement_timeout = '30s';
alter function analytics_filter_options     set statement_timeout = '10s';
alter function analytics_participation      set statement_timeout = '10s';
alter function analytics_heatmap            set statement_timeout = '10s';

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- alter function analytics_totals              reset statement_timeout;
-- alter function analytics_question_stats      reset statement_timeout;
-- alter function analytics_distribution        reset statement_timeout;
-- alter function analytics_choice_distribution reset statement_timeout;
-- alter function analytics_trends              reset statement_timeout;
-- alter function analytics_text_answers        reset statement_timeout;
-- alter function analytics_export_rows         reset statement_timeout;
-- alter function analytics_filter_options      reset statement_timeout;
-- alter function analytics_participation       reset statement_timeout;
-- alter function analytics_heatmap             reset statement_timeout;
