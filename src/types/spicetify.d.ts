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
    addEventListener(event: string, callback: (event?: any) => void): void;
    removeEventListener(event: string, callback: (event?: any) => void): void;
    getDuration?(): number;
    getProgress?(): number;
  }

  const Player: PlayerAPI;
  function showNotification(message: string): void;
}

declare const Spicetify: any;
