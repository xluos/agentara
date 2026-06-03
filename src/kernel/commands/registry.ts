import { BUILTIN_COMMANDS, helpHandler } from "./handlers";
import type { CommandHandler } from "./types";


/**
 * In-memory registry of slash commands. Kernel looks up by `name.toLowerCase()`
 * and dispatches. Single instance per kernel; no dynamic registration for v1.
 */
export class CommandRegistry {
  private readonly _map = new Map<string, CommandHandler>();

  constructor(handlers: CommandHandler[] = BUILTIN_COMMANDS) {
    for (const handler of handlers) {
      this._map.set(handler.name.toLowerCase(), handler);
    }
    this._map.set(helpHandler.name, helpHandler);
  }

  get(name: string): CommandHandler | undefined {
    return this._map.get(name.toLowerCase());
  }

  list(): CommandHandler[] {
    return Array.from(this._map.values());
  }
}
