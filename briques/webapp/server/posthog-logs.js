import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs"

const key = process.env.POSTHOG_PROJECT_TOKEN
const host = process.env.POSTHOG_HOST

const provider = key && host
  ? new LoggerProvider({
      resource: resourceFromAttributes({ "service.name": "produit-server" }),
      processors: [
        new BatchLogRecordProcessor(new OTLPLogExporter({
          url: new URL("/i/v1/logs", host).toString(),
          headers: { Authorization: `Bearer ${key}` },
        })),
      ],
    })
  : null

// Ce logger isolé n'exporte que les lignes ajoutées par cette intégration.
const logger = provider?.getLogger("posthog-log-capture")

export function journalPostHog(severityText, body, attributes = {}) {
  logger?.emit({ severityText, body, attributes })
}

export async function fermerJournauxPostHog() {
  if (provider) await provider.shutdown().catch(() => {})
}
