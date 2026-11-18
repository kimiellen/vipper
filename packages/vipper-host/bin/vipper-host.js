#!/usr/bin/env node
/**
 * vipper-host 入口（Native Messaging manifest 的 path 指向本文件）。
 * 由 Chrome 在扩展 connectNative() 时拉起，stdin EOF 即退出（§10.2）。
 */
import { main } from '../src/main.js';

main().catch((err) => {
  process.stderr.write(JSON.stringify({ event: 'host.fatal', detail: err.message }) + '\n');
  process.exit(1);
});
