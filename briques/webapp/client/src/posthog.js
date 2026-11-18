import posthogClient from "posthog-js"

const key = import.meta.env.VITE_POSTHOG_KEY
const host = import.meta.env.VITE_POSTHOG_HOST

export const posthog = key && host ? posthogClient : null

if (posthog) {
  posthog.init(key, { api_host: host })
} else if (import.meta.env.DEV) {
  if (!key) {
    console.error("VITE_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_KEY is configured")
  }
  if (!host) {
    console.error("VITE_POSTHOG_HOST variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_HOST is configured")
  }
}
