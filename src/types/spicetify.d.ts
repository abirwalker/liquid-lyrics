declare namespace Spicetify {
  interface PlayerItem {
    uri?: string;
    name?: string;
    artists?: Array<{ name: string; uri?: string }>;
    album?: { name: string; uri?: string };
    metadata?: Record<string, string | undefined>;
    duration?: { milliseconds?: number };
  }

  interface PlayerData {
    item?: PlayerItem | null;
    is_paused?: boolean;
  }

  interface PlayerAPI {
    data?: PlayerData;
    addEventListener(event: string, callback: (event?: unknown) => void): void;
    removeEventListener(event: string, callback: (event?: unknown) => void): void;
    getDuration(): number;
    getProgress(): number;
    isPlaying(): boolean;
    seek(position: number): void;
    togglePlay?(): void;
    toggleShuffle?(): void;
    toggleRepeat?(): void;
    getShuffle?(): boolean;
    getRepeat?(): number;
    getVolume?(): number;
    setVolume?(volume: number): void;
    back?(): void;
    next?(): void;
  }

  interface HistoryAPI {
    location: { pathname: string };
    push(path: string): void;
    goBack(): void;
    listen(callback: () => void): () => void;
  }

  interface RequestBuilderRequest {
    withHost(host: string): RequestBuilderRequest;
    withPath(path: string): RequestBuilderRequest;
    withQueryParameters(parameters: Record<string, string | boolean>): RequestBuilderRequest;
    withEndpointIdentifier(identifier: string): RequestBuilderRequest;
    withAbortSignal(signal: AbortSignal): RequestBuilderRequest;
    send(): Promise<{ body: unknown; status: number }>;
  }

  interface RequestBuilderAPI {
    build(): RequestBuilderRequest;
  }

  interface Button {
    active: boolean;
    element: HTMLButtonElement;
    register(): void;
    deregister(): void;
  }

  interface API {
    GraphQL?: {
      Definitions?: Record<string, unknown>;
      Request?: (definition: unknown, variables: Record<string, string | number>) => Promise<unknown>;
    };
    Player: PlayerAPI;
    showNotification(message: string, isError?: boolean): void;
    Platform?: {
      History?: HistoryAPI;
      RequestBuilder?: {
        getInstance?(): Spicetify.RequestBuilderAPI;
        build?(): Spicetify.RequestBuilderRequest;
      };
    };
    Playbar?: {
      Button: new (label: string, icon: string, onClick: () => void,
        disabled?: boolean, active?: boolean, registerOnCreate?: boolean) => Button;
    };
    Topbar?: {
      Button: new (label: string, icon: string, onClick: () => void) => {
        element: HTMLDivElement;
        button: HTMLButtonElement;
      };
    };
    Tippy?: (element: Element, options: Record<string, unknown>) => unknown;
    TippyProps?: Record<string, unknown> & { default?: Record<string, unknown> };
  }
}

declare var Spicetify: Spicetify.API | undefined;
