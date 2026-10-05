import type { WsMessage } from "@garage-control/shared-types";

export type EventSubscriber = (message: WsMessage) => void;

export class EventBus {
  private readonly subscribers = new Set<EventSubscriber>();
  subscribe(subscriber: EventSubscriber): () => void { this.subscribers.add(subscriber); return () => this.subscribers.delete(subscriber); }
  publish(message: WsMessage): void { for (const subscriber of this.subscribers) subscriber(message); }
}
