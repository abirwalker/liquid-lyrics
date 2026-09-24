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
  }

  interface HistoryAPI {
    location: { pathname: string };
    push(path: string): void;
    goBack(): void;
    listen(callback: () => void): () => void;
  }

  interface Button {
    active: boolean;
    element: HTMLButtonElement;
    register(): void;
    deregister(): void;
  }

  interface API {
    Player: PlayerAPI;
    showNotification(message: string, isError?: boolean): void;
    Platform?: { History?: HistoryAPI };
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
