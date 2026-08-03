# xhs_delete_cookies

Log out an account by **archiving** the on-disk browser profile (cookies, localStorage, IndexedDB, etc.) — not cookie-clear alone.

> Tool name kept for compatibility; since C5 the semantics are profile archive, not “clear cookies only”.

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `account` | string | No | Account name or ID |

## Response

Text indicating whether the profile was archived. Re-login with `xhs_add_account`.

## Example

```
xhs_delete_cookies({ account: "main" })
```

## Use Cases

- Log out (clear local session persistence)
- Session error, need re-login
