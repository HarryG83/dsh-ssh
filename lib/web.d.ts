/**
 * Web-facing RPC channel of dsh-ssh: mounts the connection registry and
 * registers the `/dsh-ssh` unary channel directly on the web server, speaking
 * the Connection client-request/server-response envelope behind the host's
 * Host/Origin fence and browser authentication. The client half drives
 * connection management and remote directory browsing through it; endpoints
 * are plain JSON.
 * @module dsh-ssh/web
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RegistryConfig } from './registry.ts';
/** Channel config. */
export interface WebChannelConfig extends RegistryConfig {
    /** Complete-result bound of one remote listing level. */
    maxEntries?: number;
}
/** The unary RPC result shape the shared transport expects. */
export type ChannelResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
    };
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Host connection transport; the shared RPC channel registry lives here. */
        connection: {
            /**
             * Admit one raw web request: the Host/Origin fence and browser
             * authentication verdict. `rejection` is the status to answer with, or
             * absent when the request is admitted.
             */
            admit(request: IncomingMessage): {
                rejection?: number;
            };
            rpc: {
                handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ChannelResult>, options: {
                    authority: 'loopback' | 'trusted-host';
                }): () => Promise<void>;
            };
        };
        /** Host web server; the raw route registry the channel registers into. */
        webServer: {
            register(route: {
                kind: 'prefix';
                path: string;
                handler: (request: IncomingMessage, response: ServerResponse) => void;
            }): () => void;
        };
    }
}
/** Required host service: the web transport that carries the RPC channel. */
export declare const inject: string[];
/** Validated channel config. */
export declare const Config: z<WebChannelConfig>;
/**
 * Mount the connection registry and the `/dsh-ssh` channel.
 * @param ctx - the mounting Cordis context.
 * @param config - state file and listing bound.
 */
export declare function apply(ctx: Context, config: WebChannelConfig): void;
