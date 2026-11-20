import type { Command, Reply } from './protocol';
export type CommandHandler = (args: Record<string, unknown>) => unknown;
export type HandlerTiming = 'immediate' | 'frame_end';
interface Registration {
    timing: HandlerTiming;
    handler: CommandHandler;
}
interface QueuedCommand {
    id: string;
    args: Record<string, unknown>;
    handler: CommandHandler;
}
declare class CommandDispatcher {
    handlers: Record<string, Registration>;
    queue: QueuedCommand[];
    private reply;
    private seen_ids;
    constructor(reply: (reply: Reply) => void);
    register(cmd: string, timing: HandlerTiming, handler: CommandHandler): void;
    handle(command: Command): void;
    drain(): void;
    fail_pending(code: string, message: string): void;
    private run;
    private to_error;
    private describe;
}
export { CommandDispatcher };
