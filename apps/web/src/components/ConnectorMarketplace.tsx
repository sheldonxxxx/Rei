import type { Connector } from "@rei/protocol";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/primitives/item.tsx";
import { type CatalogConnector, CONNECTOR_CATALOG, matchesCatalogUrl } from "../lib/connector-catalog.ts";
import { connectorHref } from "../lib/route.ts";

export function ConnectorMarketplace({
  connectors,
  disabled,
  onSelect,
}: {
  connectors: Connector[] | null;
  disabled: boolean;
  onSelect: (entry: CatalogConnector) => void;
}) {
  return (
    <section aria-label="Browse connectors" className="flex min-w-0 flex-col gap-3">
      <h4 className="text-sm font-medium">Browse connectors</h4>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {CONNECTOR_CATALOG.map((entry) => {
          const existing = connectors?.find((connector) => matchesCatalogUrl(connector.url, entry));
          return (
            <Item key={entry.id} variant="outline" className="min-w-0 flex-col items-stretch">
              <ItemContent>
                <ItemTitle>{entry.name}</ItemTitle>
                <ItemDescription>{entry.publisher}</ItemDescription>
              </ItemContent>
              {entry.preview && (
                <Badge variant="secondary" className="w-fit">
                  Developer preview
                </Badge>
              )}
              <p className="m-0 text-sm text-muted-foreground">{entry.description}</p>
              <div className="mt-auto flex flex-wrap items-center gap-3">
                {existing ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={connectorHref(existing.id)}>Manage {entry.name}</a>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || !connectors}
                    onClick={() => onSelect(entry)}
                  >
                    Set up {entry.name}
                  </Button>
                )}
                <a
                  className="text-xs text-muted-foreground underline underline-offset-4"
                  href={entry.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {entry.name} setup guide
                </a>
              </div>
            </Item>
          );
        })}
      </div>
    </section>
  );
}
