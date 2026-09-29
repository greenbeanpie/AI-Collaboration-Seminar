import { env as testEnv } from 'cloudflare:test';
import type { Env } from '../../src/env';

/**
 * 测试运行时绑定。cloudflare:test 的 env 类型为未生成的 Cloudflare.Env 空壳，
 * 这里统一 cast 为后端 Env 接口，供所有测试文件使用。
 */
export const env = testEnv as unknown as Env;

export const BASE = 'https://example.com';
