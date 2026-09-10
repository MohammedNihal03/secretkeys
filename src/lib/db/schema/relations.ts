import { relations } from 'drizzle-orm';

import { aiProviders } from './ai-providers';
import { apiKeys } from './api-keys';
import { monitoredDatabases } from './monitored-databases';
import { organizationMembers } from './organization-members';
import { organizationProviders } from './organization-providers';
import { organizations } from './organizations';
import { projects } from './projects';
import { sessions } from './sessions';
import { users } from './users';

/**
 * Relation metadata for Drizzle's relational query API.
 *
 * These are a query-time convenience only -- the constraints that actually
 * protect the data are the foreign keys declared on the tables themselves.
 */

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  providerSelections: many(organizationProviders),
  projects: many(projects),
  apiKeys: many(apiKeys),
  monitoredDatabases: many(monitoredDatabases),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  apiKeys: many(apiKeys),
  monitoredDatabases: many(monitoredDatabases),
}));

export const aiProvidersRelations = relations(aiProviders, ({ many }) => ({
  apiKeys: many(apiKeys),
  selections: many(organizationProviders),
}));

export const organizationProvidersRelations = relations(organizationProviders, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationProviders.organizationId],
    references: [organizations.id],
  }),
  provider: one(aiProviders, {
    fields: [organizationProviders.providerId],
    references: [aiProviders.id],
  }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [apiKeys.projectId],
    references: [projects.id],
  }),
  provider: one(aiProviders, {
    fields: [apiKeys.providerId],
    references: [aiProviders.id],
  }),
}));

export const monitoredDatabasesRelations = relations(monitoredDatabases, ({ one }) => ({
  organization: one(organizations, {
    fields: [monitoredDatabases.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [monitoredDatabases.projectId],
    references: [projects.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(organizationMembers),
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
}));
