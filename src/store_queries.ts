export interface SubscriptionListFilters {
  sourceId?: string;
  agentId?: string;
  limit?: number;
}

export interface StoreQuery {
  sql: string;
  params: unknown[];
}

export function buildSubscriptionListQuery(filters?: SubscriptionListFilters): StoreQuery {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.sourceId) {
    clauses.push("source_id = ?");
    params.push(filters.sourceId);
  }
  if (filters?.agentId) {
    clauses.push("agent_id = ?");
    params.push(filters.agentId);
  }
  const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
  const limitClause = typeof filters?.limit === "number" ? " limit ?" : "";
  if (typeof filters?.limit === "number") {
    params.push(filters.limit);
  }
  return {
    sql: `select * from subscriptions${where} order by created_at asc, subscription_id asc${limitClause}`,
    params,
  };
}
