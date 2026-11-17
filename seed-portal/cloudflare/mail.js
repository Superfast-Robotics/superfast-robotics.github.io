import { connect } from 'cloudflare:sockets';
import { createSmtpClient } from './smtp-client.js';

export { mailReady } from './smtp-client.js';
const client = createSmtpClient(connect);
export const sendAccessMail = (env, message) => client.sendAccessMail(env, message);
export const verifySmtp = env => client.verifySmtp(env);
