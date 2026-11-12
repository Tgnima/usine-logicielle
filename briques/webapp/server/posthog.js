import { PostHog } from "posthog-node"

const key = process.env.POSTHOG_PROJECT_TOKEN
const host = process.env.POSTHOG_HOST

export const posthog = key && host
  ? new PostHog(key, { host, enableExceptionAutocapture: true, privacyMode: false })
  : null

if (!posthog && process.env.NODE_ENV !== "production") {
  if (!key) {
    console.warn("POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_PROJECT_TOKEN is configured")
  }
  if (!host) {
    console.warn("POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_HOST is configured")
  }
}
