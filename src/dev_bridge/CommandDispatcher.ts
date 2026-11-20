import type { Command, Reply } from './protocol';

// `unknown` already absorbs Promise<unknown>; run() normalises both via Promise.resolve.
export type CommandHandler = (args: Record<string, unknown>) => unknown;
export type HandlerTiming = 'immediate' | 'frame_end';

interface Registration
{
  timing: HandlerTiming;
  handler: CommandHandler;
}

interface QueuedCommand
{
  id: string;
  args: Record<string, unknown>;
  handler: CommandHandler;
}

class CommandDispatcher
{
  handlers: Record<string, Registration>;
  queue: QueuedCommand[];

  private reply: (reply: Reply) => void;
  private seen_ids: Set<string>;

  constructor(reply: (reply: Reply) => void)
  {
    this.reply = reply;
    this.handlers = {};
    this.queue = [];
    this.seen_ids = new Set();
  }

  register(cmd: string, timing: HandlerTiming, handler: CommandHandler)
  {
    this.handlers[cmd] = { timing, handler };
  }

  handle(command: Command)
  {
    // One id runs once per connection: a retransmitted command must not
    // mutate the scene a second time.
    if (this.seen_ids.has(command.id))
    {
      this.reply({
        id: command.id,
        ok: false,
        error: { code: 'duplicate_command', message: `Command id '${command.id}' was already received.` }
      });

      return;
    }

    this.seen_ids.add(command.id);

    const registration = this.handlers[command.cmd];
    const args = command.args === undefined ? {} : command.args;

    if (registration === undefined)
    {
      this.reply({
        id: command.id,
        ok: false,
        error: { code: 'unknown_command', message: `Unknown command '${command.cmd}'` }
      });

      return;
    }

    if (registration.timing === 'frame_end')
    {
      this.queue.push({ id: command.id, args, handler: registration.handler });
      return;
    }

    this.run(command.id, args, registration.handler);
  }

  // Called from MainApplication.on_frame_end() so rendering and mutation
  // never happen part-way through a frame. The queue is swapped out before
  // anything runs, so a command arriving while this drains waits for the
  // next frame instead of inserting into the current round.
  drain()
  {
    const queued = this.queue;
    this.queue = [];

    for (const command of queued)
    {
      this.run(command.id, command.args, command.handler);
    }
  }

  // DevBridge calls this when the connection closes or the bridge is
  // disposed. Queued commands belong to the dead connection: they fail
  // loudly here instead of hanging forever, and never run against the stale
  // scene a later connection would see. The next connection starts with an
  // empty queue and no remembered ids.
  fail_pending(code: string, message: string)
  {
    const queued = this.queue;
    this.queue = [];
    this.seen_ids.clear();

    for (const command of queued)
    {
      this.reply({ id: command.id, ok: false, error: { code, message } });
    }
  }

  private run(id: string, args: Record<string, unknown>, handler: CommandHandler)
  {
    try
    {
      Promise.resolve(handler(args))
        .then((result) => this.reply({ id, ok: true, result }))
        .catch((error) => this.reply({ id, ok: false, error: this.to_error(error) }));
    }
    catch (error)
    {
      this.reply({ id, ok: false, error: this.to_error(error) });
    }
  }

  private to_error(error: unknown): { code: string; message: string }
  {
    const code = (error as { code?: string })?.code;
    const message = (error as { message?: string })?.message;

    return {
      code: code === undefined ? 'handler_failed' : code,
      message: typeof message === 'string' ? message : this.describe(error)
    };
  }

  // Avoids '[object Object]' reaching the developer for a thrown non-Error.
  private describe(error: unknown): string
  {
    if (typeof error === 'string')
    {
      return error;
    }

    return `Handler failed with a non-Error value of type ${typeof error}`;
  }
}

export { CommandDispatcher };
