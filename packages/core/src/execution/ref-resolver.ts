/**
 * Provider-token ref resolver — shared helper used by both the chunk and
 * tasklet step executors to resolve a `RefKind.ProviderToken` ref against
 * a `Map<string, unknown>` of pre-resolved provider instances.
 *
 * The caller (typically the JobExecutor) builds the map by walking the
 * `JobDefinition` and looking each ref's `token` up in the Nest DI
 * container (`ModuleRef.get(token, { strict: false })`). The executors
 * themselves never touch the container — they only consult this map.
 *
 * The error message format is centralized here so every role
 * (`reader` / `processor` / `writer` / `tasklet` / `listener`) reports
 * missing tokens identically. The tests assert on
 * `exitMessage.includes(missingTokenId)`.
 */

/** Role label used to disambiguate error messages from the chunk/tasklet
 *  resolvers. Lowercase to match the surrounding executor code style. */
export type ProviderTokenRole = 'reader' | 'processor' | 'writer' | 'tasklet' | 'listener';

/** A provider instance bound to a string token. The runtime shape is
 *  determined by the role (e.g. `ItemReader` for `reader`), but the map
 *  itself is intentionally `unknown` so the resolver can serve every
 *  role from a single helper. */
export type ProviderResolvers = Map<string, unknown>;

/**
 * Resolve a `RefKind.ProviderToken` ref to the bound provider instance.
 *
 * Throws a deterministic `Error` whose message contains BOTH the
 * missing token id and the role label when the token is not bound.
 * The chunk/tasklet executors' outer `try/catch` propagates this
 * message into the `exitMessage` of the FAILED result.
 *
 * @param role    The semantic role of the ref (used only in error messages).
 * @param ref     The `RefKind.ProviderToken` ref (must have a `token` field).
 * @param map     The provider-resolver map built by the caller.
 * @returns       The bound instance, narrowed to `T` at the call site.
 */
export function resolveProviderToken<T>(
  role: ProviderTokenRole,
  ref: { token?: string },
  map: ProviderResolvers | undefined,
): T {
  const token = ref.token;
  if (!token) {
    throw new Error(
      `Missing token on ${role} ref: RefKind.ProviderToken requires a non-empty \`token\` field`,
    );
  }
  if (!map) {
    throw new Error(
      `No provider resolvers available for ${role} ref (token=${token}); ` +
        `the executor context did not receive a \`providerResolvers\` map`,
    );
  }
  const instance = map.get(token);
  if (instance === undefined) {
    throw new Error(
      `Provider for ${role} token "${token}" was not found in the provider resolvers map`,
    );
  }
  return instance as T;
}
