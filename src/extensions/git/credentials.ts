import type {
  GitCredentials,
  GitCredentialsProvider,
} from './service.js'

export type GitCredentialStore = {
  get: (key: string) => Promise<string | undefined>
  set: (key: string, value: string) => Promise<void>
  remove: (key: string) => Promise<void>
}

/*
 * Secret keys are namespaced by the registry under
 *   git.cred.<cacheKey>
 * where cacheKey is the remote origin (protocol + hostname + port).
 *
 * PATs work for both GitHub (username "x-access-token" or blank + PAT as
 * password) and GitLab (username "oauth2" + PAT as password), so a single
 * username/password pair per host is enough.
 */
export type GitCredentialPrompt = (
  message: string,
) => Promise<{
  username?: string
  password?: string
} | undefined>

function getCacheKey(url: string): string {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return 'default'
  }

  return `${parsed.protocol}//${parsed.host}`
}

export function createCredentialProvider(
  store: GitCredentialStore,
  prompt: GitCredentialPrompt,
): GitCredentialsProvider {
  async function loadCredentials(url: string): Promise<GitCredentials> {
    const cacheKey = getCacheKey(url)
    const raw = await store.get(`cred.${cacheKey}`)

    if (raw != null) {
      try {
        const parsed = JSON.parse(raw) as {
          username?: string
          password?: string
        }

        if (parsed?.password != null) {
          return {
            username: parsed.username,
            password: parsed.password,
          }
        }
      } catch {
        /*
         * Corrupted secret content: fall through to the prompt and
         * overwrite on the next save.
         */
      }
    }

    const prompted = await prompt(`Credentials for ${url}`)

    if (prompted?.password == null) {
      /*
       * Anonymous access - isomorphic-git will send no auth header. Public
       * repositories work this way.
       */
      return {}
    }

    await store.set(
      `cred.${cacheKey}`,
      JSON.stringify({
        username: prompted.username,
        password: prompted.password,
      }),
    )

    return {
      username: prompted.username,
      password: prompted.password,
    }
  }

  return loadCredentials
}

export async function forgetCredentials(
  store: GitCredentialStore,
  url: string,
): Promise<void> {
  await store.remove(`cred.${getCacheKey(url)}`)
}
