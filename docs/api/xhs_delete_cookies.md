# xhs_delete_cookies

登出账号：关闭浏览器并**归档** on-disk profile（Cookie / localStorage / IndexedDB 等），不仅清除 Cookie。

> 工具名保留历史兼容；C5 起语义为 profile 归档，非「只清 Cookie」。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `account` | string | 否 | 账号名称或 ID |

## 返回值

文本说明是否已归档 profile；需重新 `xhs_add_account` 登录。

## 示例

```
xhs_delete_cookies({ account: "主账号" })
```

## 使用场景

- 登出账号（清除本机会话持久化）
- 会话异常需要重新登录
