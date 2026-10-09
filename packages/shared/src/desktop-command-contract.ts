import type { DesktopApi } from './index';

export type DesktopCommandGroup = keyof DesktopApi;
export type DesktopCommandName<Group extends DesktopCommandGroup> = keyof DesktopApi[Group];

export type DesktopCommandRequest<
  Group extends DesktopCommandGroup,
  Name extends DesktopCommandName<Group>,
> = DesktopApi[Group][Name] extends (...args: infer Args) => Promise<unknown> ? Args : never;

export type DesktopCommandResult<
  Group extends DesktopCommandGroup,
  Name extends DesktopCommandName<Group>,
> = DesktopApi[Group][Name] extends (...args: infer _Args) => Promise<infer Result> ? Result : never;

export interface DesktopCommandError {
  code: string;
  message: string;
  retryable: boolean;
}
