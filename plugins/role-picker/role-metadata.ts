// Fork (BBP-60): Agent Roles' thread metadata, as Role Picker writes and reads it.
// Agent Roles owns the format (plugins/agent-roles/thread-role.ts). bb's server
// builds each plugin from its own folder only, so this is a copy;
// role-metadata.test.ts fails if the two drift apart.

export type RoleMetadata = {
  roleId: string;
  roleSlug: string;
  roleName: string;
  roleColor: string;
  taskKey?: string | null;
};

/** The metadata for a thread with `role`, or for a cleared role (`null`): every role key is then "". */
export function roleMetadata(role: { id: string; slug: string; name: string; color: string } | null, taskKey?: string | null): RoleMetadata {
  const keys = role ? { roleId: role.id, roleSlug: role.slug, roleName: role.name, roleColor: role.color } : { roleId: "", roleSlug: "", roleName: "", roleColor: "" };
  return taskKey === undefined ? keys : { ...keys, taskKey };
}

/** The role slug the metadata states: a slug, "" when cleared, undefined when it says nothing. */
export function metadataRoleSlug(metadata: { readonly [key: string]: unknown }): string | undefined {
  return typeof metadata.roleSlug === "string" ? metadata.roleSlug : undefined;
}
