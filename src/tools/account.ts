/**
 * @fileoverview MCP tool definitions and handlers for account management.
 * Provides tools for listing, adding, removing, and configuring accounts.
 * @module tools/account
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AccountPool } from '../core/account-pool.js';
import { generateProfileId } from '../core/profile.js';
import { XhsDatabase } from '../db/index.js';
import { getLoginSessionManager, LoginSession } from '../core/login-session.js';
import { getPrompt, setPrompt, PromptType, deleteAccountPrompts } from '../core/prompt-manager.js';
import { validateProxyInput } from '../core/proxy.js';
import { mergeAccountLocaleEnv } from '../core/locale-env.js';

/**
 * Account management tool definitions for MCP.
 */
export const accountTools: Tool[] = [
  {
    name: 'xhs_list_accounts',
    description: 'List all registered Xiaohongshu accounts with their status and last activity.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'xhs_add_account',
    description: `Start login process for a new or existing account.
Returns a QR code URL for scanning. After user scans the QR code,
call xhs_check_login_session to check status and complete the login.

Flow:
1. Call xhs_add_account -> get sessionId and qrCodeUrl
2. Show QR code URL to user for scanning
3. Call xhs_check_login_session with sessionId to check status
4. If verification needed, call xhs_submit_verification with code
5. Login complete when status is 'success'`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Optional account name. If provided and account exists, triggers re-login. If not provided, nickname from login will be used.',
        },
        proxy: {
          type: 'string',
          description:
            'Optional proxy: http://host:port, http://user:pass@host:port, or JSON {"server":"http://host:port","username":"...","password":"..."}. Multi-account writes require distinct proxies (XHS_MCP_AD_PROXY_REQUIRED).',
        },
      },
      required: [],
    },
  },
  {
    name: 'xhs_check_login_session',
    description: `Check login status and complete the login process.
Call this after user scans the QR code from xhs_add_account.
May return verification_required if SMS code is needed.

Status values:
- waiting_scan: QR code not scanned yet
- scanned: QR code scanned, processing
- verification_required: SMS code needed, call xhs_submit_verification
- success: Login complete
- expired: Session expired, start new login
- failed: Login failed`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID from xhs_add_account',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'xhs_submit_verification',
    description: `Submit SMS verification code to complete login.
Only call this when xhs_check_login_session returns status: verification_required.
Verification code expires in 1 minute.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID from xhs_add_account',
        },
        code: {
          type: 'string',
          description: '6-digit SMS verification code',
        },
      },
      required: ['sessionId', 'code'],
    },
  },
  {
    name: 'xhs_remove_account',
    description: 'Remove a registered account and delete its session data.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Account name or ID to remove',
        },
      },
      required: ['account'],
    },
  },
  {
    name: 'xhs_set_account_config',
    description:
      'Update account configuration: name, proxy, status, and C3 locale env (timezoneId / locale / geolocation). Geolocation requires timezoneId and locale.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Account name or ID to update',
        },
        name: {
          type: 'string',
          description: 'New name for the account',
        },
        proxy: {
          type: 'string',
          description:
            'New proxy (empty string to remove). Formats: http://host:port, http://user:pass@host:port, or JSON with server/username/password. Multi-account writes require distinct host:port per account.',
        },
        status: {
          type: 'string',
          enum: ['active', 'suspended', 'banned'],
          description: 'Account status',
        },
        timezoneId: {
          type: 'string',
          description: 'IANA timezone (e.g. Asia/Shanghai). Empty string clears. Recommended when using geo proxy.',
        },
        locale: {
          type: 'string',
          description: 'BCP-47 locale (e.g. zh-CN). Empty string clears. Drives navigator.languages / Accept-Language.',
        },
        geolocation: {
          type: 'object',
          description:
            'Browser geolocation. Requires timezoneId + locale on the account after merge. Pass null to clear (JSON null).',
          properties: {
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            accuracy: { type: 'number' },
          },
        },
      },
      required: ['account'],
    },
  },
  {
    name: 'xhs_get_account_prompt',
    description:
      'Get the prompt file content for an account. Prompts control AI behavior during explore (note selection and comment generation).',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Account name or ID',
        },
        type: {
          type: 'string',
          enum: ['persona', 'select', 'comment'],
          description:
            'Type of prompt to get: persona (base character), select (note selection), comment (comment generation)',
        },
      },
      required: ['account', 'type'],
    },
  },
  {
    name: 'xhs_set_account_prompt',
    description: 'Update the prompt file content for an account. Use this to customize AI behavior during explore.',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Account name or ID',
        },
        type: {
          type: 'string',
          enum: ['persona', 'select', 'comment'],
          description: 'Type of prompt to update',
        },
        content: {
          type: 'string',
          description: 'New prompt content. For select/comment, use {{ persona }} to reference the persona.',
        },
      },
      required: ['account', 'type', 'content'],
    },
  },
];

/**
 * Format session status for response
 */
function formatSessionResponse(session: LoginSession, extra?: Record<string, any>) {
  const now = new Date();
  const remainingTime =
    session.status === 'waiting_scan'
      ? Math.max(0, Math.floor((session.qrExpiresAt.getTime() - now.getTime()) / 1000))
      : session.verificationExpiresAt
        ? Math.max(0, Math.floor((session.verificationExpiresAt.getTime() - now.getTime()) / 1000))
        : undefined;

  const nextAction = getNextAction(session);

  return {
    success: session.status !== 'failed' && session.status !== 'expired',
    sessionId: session.id,
    status: session.status,
    ...(session.qrCodeUrl && session.status === 'waiting_scan' && { qrCodeUrl: session.qrCodeUrl }),
    ...(session.verificationPhone && { phone: session.verificationPhone }),
    ...(remainingTime !== undefined && { remainingTime }),
    ...(session.rateLimited && {
      rateLimited: true,
      rateLimitMessage: 'SMS rate limit reached for today. Try again tomorrow.',
    }),
    ...(session.error && { error: session.error }),
    ...(nextAction && { nextAction }),
    ...extra,
  };
}

/**
 * Get next action hint based on session status
 */
function getNextAction(session: LoginSession): string | null {
  switch (session.status) {
    case 'waiting_scan':
      return 'Show QR code URL to user. After scanning, call xhs_check_login_session with this sessionId.';
    case 'scanned':
      return 'QR code scanned. Call xhs_check_login_session again to check if login is complete.';
    case 'verification_required':
      return `SMS verification required. Ask user for the 6-digit code, then call xhs_submit_verification within ${
        session.verificationExpiresAt ? Math.ceil((session.verificationExpiresAt.getTime() - Date.now()) / 1000) : 60
      } seconds.`;
    case 'success':
      return null;
    case 'expired':
      return 'Session expired. Call xhs_add_account to start a new login.';
    case 'failed':
      return 'Login failed. Call xhs_add_account to start a new login.';
    default:
      return null;
  }
}

/**
 * Handle account management tool calls.
 *
 * @param name - Tool name
 * @param args - Tool arguments
 * @param pool - Account pool instance
 * @param db - Database instance
 * @returns MCP tool response
 */
export async function handleAccountTools(name: string, args: any, pool: AccountPool, db: XhsDatabase) {
  const sessionManager = getLoginSessionManager();

  switch (name) {
    case 'xhs_list_accounts': {
      const accounts = pool.listAccounts();

      const accountList = accounts.map((acc) => {
        const profile = db.profiles.findByAccountId(acc.id);
        const stats = db.operations.getStats(acc.id);

        return {
          id: acc.id,
          name: acc.name,
          status: acc.status,
          proxy: acc.proxy || null,
          timezoneId: acc.timezoneId || null,
          locale: acc.locale || null,
          geolocation: acc.geolocation || null,
          hasSession: !!acc.state,
          profile: profile
            ? {
                userId: profile.userId,
                redId: profile.redId,
                nickname: profile.nickname,
                avatar: profile.avatar,
              }
            : null,
          stats: {
            totalOperations: stats.totalOperations,
            successRate:
              stats.totalOperations > 0 ? Math.round((stats.successfulOperations / stats.totalOperations) * 100) : 0,
          },
          lastLoginAt: acc.lastLoginAt?.toISOString() || null,
          lastActiveAt: acc.lastActiveAt?.toISOString() || null,
          isLocked: pool.isAccountLocked(acc.id),
        };
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                count: accountList.length,
                accounts: accountList,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'xhs_add_account': {
      const params = z
        .object({
          name: z.string().min(1).max(64).optional(),
          proxy: z.string().optional(),
        })
        .parse(args);

      if (params.proxy !== undefined) {
        const proxyCheck = validateProxyInput(params.proxy);
        if (!proxyCheck.ok) {
          return {
            content: [{ type: 'text', text: proxyCheck.error }],
            isError: true,
          };
        }
      }

      try {
        // Check if this is a re-login for existing account
        if (params.name) {
          const existing = pool.getAccount(params.name);
          if (existing) {
            // Close existing client if any
            await pool.removeClient(existing.id);
          }
        }

        // Create login session
        const session = await sessionManager.createSession(params.name, params.proxy);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formatSessionResponse(session), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  nextAction: 'Fix the issue and call xhs_add_account again.',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    }

    case 'xhs_check_login_session': {
      const params = z
        .object({
          sessionId: z.string(),
        })
        .parse(args);

      try {
        const session = await sessionManager.checkStatus(params.sessionId);

        // If login successful, create account in database
        if (session.status === 'success' && session.userInfo && session.state) {
          const { state, userInfo, fullProfile } = await sessionManager.completeSession(params.sessionId);

          // Create or update account
          const accountName = session.accountName || userInfo.nickname;
          const { account, isExisting } = await pool.createAccountAfterLogin(
            accountName,
            state,
            session.proxy,
            userInfo.userId,
            { profileId: generateProfileId(), sessionId: params.sessionId },
          );

          // Save user profile（优先使用完整资料）
          if (fullProfile) {
            db.profiles.upsert({
              accountId: account.id,
              userId: fullProfile.userId,
              redId: fullProfile.redId,
              nickname: fullProfile.nickname,
              avatar: fullProfile.avatar,
              description: fullProfile.description,
              gender: fullProfile.gender,
              ipLocation: fullProfile.ipLocation,
              followers: fullProfile.followers,
              following: fullProfile.following,
              likeAndCollect: fullProfile.likeAndCollect,
              isBanned: fullProfile.isBanned,
              banCode: fullProfile.banCode,
              banReason: fullProfile.banReason,
            });
          } else {
            db.profiles.upsert({
              accountId: account.id,
              userId: userInfo.userId,
              redId: userInfo.redId,
              nickname: userInfo.nickname,
              avatar: userInfo.avatar,
              description: userInfo.desc,
              gender: userInfo.gender,
            });
          }

          // Log operation
          db.operations.log({
            accountId: account.id,
            action: 'login',
            success: true,
            result: { method: 'qr_code', userInfo, fullProfile },
          });

          // 构建返回的用户信息
          const returnUserInfo = fullProfile
            ? {
                userId: fullProfile.userId,
                redId: fullProfile.redId,
                nickname: fullProfile.nickname,
                followers: fullProfile.followers,
                following: fullProfile.following,
                likeAndCollect: fullProfile.likeAndCollect,
                isBanned: fullProfile.isBanned,
              }
            : {
                userId: userInfo.userId,
                redId: userInfo.redId,
                nickname: userInfo.nickname,
              };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    status: 'success',
                    account: {
                      id: account.id,
                      name: account.name,
                      status: account.status,
                    },
                    userInfo: returnUserInfo,
                    message: isExisting
                      ? 'Login successful. Existing account session updated.'
                      : 'Login successful. Account created.',
                    nextAction: null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formatSessionResponse(session), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  nextAction: 'Call xhs_add_account to start a new login session.',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    }

    case 'xhs_submit_verification': {
      const params = z
        .object({
          sessionId: z.string(),
          code: z.string().min(4).max(8),
        })
        .parse(args);

      try {
        const session = await sessionManager.submitVerification(params.sessionId, params.code);

        // If login successful, create account in database
        if (session.status === 'success' && session.userInfo && session.state) {
          const { state, userInfo, fullProfile } = await sessionManager.completeSession(params.sessionId);

          // Create or update account
          const accountName = session.accountName || userInfo.nickname;
          const { account, isExisting } = await pool.createAccountAfterLogin(
            accountName,
            state,
            session.proxy,
            userInfo.userId,
            { profileId: generateProfileId(), sessionId: params.sessionId },
          );

          // Save user profile（优先使用完整资料）
          if (fullProfile) {
            db.profiles.upsert({
              accountId: account.id,
              userId: fullProfile.userId,
              redId: fullProfile.redId,
              nickname: fullProfile.nickname,
              avatar: fullProfile.avatar,
              description: fullProfile.description,
              gender: fullProfile.gender,
              ipLocation: fullProfile.ipLocation,
              followers: fullProfile.followers,
              following: fullProfile.following,
              likeAndCollect: fullProfile.likeAndCollect,
              isBanned: fullProfile.isBanned,
              banCode: fullProfile.banCode,
              banReason: fullProfile.banReason,
            });
          } else {
            db.profiles.upsert({
              accountId: account.id,
              userId: userInfo.userId,
              redId: userInfo.redId,
              nickname: userInfo.nickname,
              avatar: userInfo.avatar,
              description: userInfo.desc,
              gender: userInfo.gender,
            });
          }

          // Log operation
          db.operations.log({
            accountId: account.id,
            action: 'login',
            success: true,
            result: { method: 'qr_code_with_verification', userInfo, fullProfile },
          });

          // 构建返回的用户信息
          const returnUserInfo = fullProfile
            ? {
                userId: fullProfile.userId,
                redId: fullProfile.redId,
                nickname: fullProfile.nickname,
                followers: fullProfile.followers,
                following: fullProfile.following,
                likeAndCollect: fullProfile.likeAndCollect,
                isBanned: fullProfile.isBanned,
              }
            : {
                userId: userInfo.userId,
                redId: userInfo.redId,
                nickname: userInfo.nickname,
              };

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    status: 'success',
                    account: {
                      id: account.id,
                      name: account.name,
                      status: account.status,
                    },
                    userInfo: returnUserInfo,
                    message: isExisting
                      ? 'Verification successful. Existing account session updated.'
                      : 'Verification successful. Account created.',
                    nextAction: null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(formatSessionResponse(session), null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                  nextAction:
                    error instanceof Error && error.message.includes('status')
                      ? 'Check current status with xhs_check_login_session first.'
                      : 'Try submitting the code again or start a new login.',
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    }

    case 'xhs_remove_account': {
      const params = z
        .object({
          account: z.string(),
        })
        .parse(args);

      const account = pool.getAccount(params.account);
      if (!account) {
        return {
          content: [
            {
              type: 'text',
              text: `Account not found: ${params.account}`,
            },
          ],
          isError: true,
        };
      }

      // 删除账号的 prompt 目录
      deleteAccountPrompts(account.name, account.id);

      const removed = await pool.removeAccount(params.account);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: removed,
                message: removed ? `Account "${account.name}" has been removed.` : 'Failed to remove account.',
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'xhs_set_account_config': {
      const geoSchema = z
        .object({
          latitude: z.number().finite(),
          longitude: z.number().finite(),
          accuracy: z.number().finite().optional(),
        })
        .nullable()
        .optional();

      const params = z
        .object({
          account: z.string(),
          name: z.string().min(1).max(64).optional(),
          proxy: z.string().optional(),
          status: z.enum(['active', 'suspended', 'banned', 'migration_required']).optional(),
          timezoneId: z.string().optional(),
          locale: z.string().optional(),
          geolocation: geoSchema,
        })
        .parse(args);

      const account = pool.getAccount(params.account);
      if (!account) {
        return {
          content: [
            {
              type: 'text',
              text: `Account not found: ${params.account}`,
            },
          ],
          isError: true,
        };
      }

      // R3-7：profileId 硬不变量——空 profile 的账号不得置为 active（fail-closed）。
      // 恢复路径是 xhs_add_account 重登录绑定独立 profile，而非直接改 status。
      if (params.status === 'active' && !account.profileId) {
        return {
          content: [
            {
              type: 'text',
              text: `拒绝将缺少独立 profile 的账号 "${account.name}" 设为 active（隔离硬不变量）。请先 xhs_add_account 重登录绑定独立 profile。`,
            },
          ],
          isError: true,
        };
      }

      if (params.proxy !== undefined) {
        const proxyCheck = validateProxyInput(params.proxy);
        if (!proxyCheck.ok) {
          return {
            content: [{ type: 'text', text: proxyCheck.error }],
            isError: true,
          };
        }
      }

      // C3：合并校验属地（空串清除 timezone/locale；geolocation null 清除）
      const localePatch: {
        timezoneId?: string | null;
        locale?: string | null;
        geolocation?: { latitude: number; longitude: number; accuracy?: number } | null;
      } = {};
      if (params.timezoneId !== undefined) {
        localePatch.timezoneId = params.timezoneId.trim() === '' ? null : params.timezoneId;
      }
      if (params.locale !== undefined) {
        localePatch.locale = params.locale.trim() === '' ? null : params.locale;
      }
      if (params.geolocation !== undefined) {
        localePatch.geolocation = params.geolocation;
      }

      let mergedLocale: {
        timezoneId?: string;
        locale?: string;
        geolocation?: { latitude: number; longitude: number; accuracy?: number };
      } | null = null;
      if (
        localePatch.timezoneId !== undefined ||
        localePatch.locale !== undefined ||
        localePatch.geolocation !== undefined
      ) {
        const merged = mergeAccountLocaleEnv(
          {
            timezoneId: account.timezoneId,
            locale: account.locale,
            geolocation: account.geolocation,
          },
          localePatch,
        );
        if (!merged.ok) {
          return {
            content: [{ type: 'text', text: merged.error }],
            isError: true,
          };
        }
        mergedLocale = merged.value;
      }

      const updates: {
        name?: string;
        proxy?: string;
        status?: 'active' | 'suspended' | 'banned' | 'migration_required';
        timezoneId?: string | null;
        locale?: string | null;
        geolocation?: { latitude: number; longitude: number; accuracy?: number } | null;
      } = {};
      if (params.name !== undefined) {
        updates.name = params.name;
      }
      if (params.proxy !== undefined) {
        updates.proxy = params.proxy;
      }
      if (params.status !== undefined) {
        updates.status = params.status;
      }
      // 写回校验后的 merged.value，避免 patch 里 NaN/非法值绕过合并结果落库
      if (mergedLocale && localePatch.timezoneId !== undefined) {
        updates.timezoneId = mergedLocale.timezoneId ?? null;
      }
      if (mergedLocale && localePatch.locale !== undefined) {
        updates.locale = mergedLocale.locale ?? null;
      }
      if (mergedLocale && localePatch.geolocation !== undefined) {
        updates.geolocation = mergedLocale.geolocation ?? null;
      }

      const updated = await pool.updateAccountConfig(params.account, updates);

      // Get updated account
      const updatedAccount = pool.getAccount(params.account);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: updated,
                account: updatedAccount
                  ? {
                      id: updatedAccount.id,
                      name: updatedAccount.name,
                      status: updatedAccount.status,
                      proxy: updatedAccount.proxy || null,
                      timezoneId: updatedAccount.timezoneId || null,
                      locale: updatedAccount.locale || null,
                      geolocation: updatedAccount.geolocation || null,
                    }
                  : null,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'xhs_get_account_prompt': {
      const params = z
        .object({
          account: z.string(),
          type: z.enum(['persona', 'select', 'comment']),
        })
        .parse(args);

      const account = pool.getAccount(params.account);
      if (!account) {
        return {
          content: [
            {
              type: 'text',
              text: `Account not found: ${params.account}`,
            },
          ],
          isError: true,
        };
      }

      const content = getPrompt(account.name, account.id, params.type as PromptType);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                account: account.name,
                promptType: params.type,
                content,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'xhs_set_account_prompt': {
      const params = z
        .object({
          account: z.string(),
          type: z.enum(['persona', 'select', 'comment']),
          content: z.string().min(1),
        })
        .parse(args);

      const account = pool.getAccount(params.account);
      if (!account) {
        return {
          content: [
            {
              type: 'text',
              text: `Account not found: ${params.account}`,
            },
          ],
          isError: true,
        };
      }

      setPrompt(account.name, account.id, params.type as PromptType, params.content);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                account: account.name,
                promptType: params.type,
                message: `Prompt "${params.type}" updated successfully.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown account tool: ${name}`);
  }
}
