import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/primitives/tabs.tsx";
import type { Api } from "../api/client.ts";
import { navigate, settingsHref } from "../lib/route.ts";
import { CodexImagesSettings } from "./CodexImagesSettings.tsx";
import { EmbeddingSettings } from "./EmbeddingSettings.tsx";
import { PageShell } from "./PageShell.tsx";
import { ProvidersPage } from "./ProvidersPage.tsx";
import { SetupServices } from "./SetupServices.tsx";

export function ProviderSettingsPage({ api, tab }: { api: Api; tab: string | null }) {
  const selected = tab === "embedding" || tab === "search" || tab === "images" ? tab : "chat";
  return (
    <PageShell title="Providers">
      <Tabs
        value={selected}
        onValueChange={(value) => {
          navigate(settingsHref("providers", value === "chat" ? null : value));
        }}
        className="min-w-0 gap-5"
      >
        <TabsList aria-label="Provider types" className="max-w-full">
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="embedding">Embeddings</TabsTrigger>
          <TabsTrigger value="search">Web search</TabsTrigger>
          <TabsTrigger value="images">Images</TabsTrigger>
        </TabsList>
        <TabsContent value="chat">
          <ProvidersPage
            api={api}
            embedded
            description="Connect a provider, then choose models in Settings → Models."
          />
        </TabsContent>
        <TabsContent value="embedding">
          <EmbeddingSettings api={api} onSaved={() => {}} />
        </TabsContent>
        <TabsContent value="search">
          <SetupServices api={api} kind="search" onSaved={() => {}} />
        </TabsContent>
        <TabsContent value="images">
          <CodexImagesSettings api={api} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
