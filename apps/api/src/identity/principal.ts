/** The signed-in person, as the platform sees them after validating their Entra token. */
export type Role = "Foundry.User" | "Foundry.Builder" | "Foundry.Reviewer" | "Foundry.Admin";

export interface Principal {
  /** oid + tid is the identity; names and emails are for display only */
  tid: string;
  oid: string;
  name: string;
  roles: Role[];
  /** display names of the configured groups the person is in */
  groups: string[];
  /** countries whose operational data the person may see, or ["*"] */
  countries: string[];
  /** false when group membership could not be determined (overage and Graph unavailable) */
  groupsKnown: boolean;
  /** how they authenticated */
  via: "session" | "token";
  /** scopes of a personal access token */
  scopes?: string[];
}

export const has = (p: Principal, ...roles: Role[]) => roles.some((r) => p.roles.includes(r));
