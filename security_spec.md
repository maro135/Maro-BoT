# Security Specification for WhatsApp Bot

## 1. Data Invariants
- `User` documents must have `points`, `warnings`, and `banned` fields.
- `points` and `warnings` must be non-negative integers.
- Only the documented paths `/users/{userId}`, `/groups/{groupId}`, and `/settings/global` are allowed.
- Access to global settings should be restricted to authenticated administrators.
- Access to user data should be limited to the bot service or the user themselves (if authenticated).

## 2. The "Dirty Dozen" Payloads
1. **Shadow Field Injection**: `{"points": 100, "warnings": 0, "banned": false, "isAdmin": true}` -> REJECTED (Shadow field `isAdmin`).
2. **Negative Points**: `{"points": -50, "warnings": 0, "banned": false}` -> REJECTED (Negative value).
3. **Invalid Data Type**: `{"points": "many", "warnings": 0, "banned": false}` -> REJECTED (String instead of integer).
4. **Unauthorized Global Setting Change**: Attempt to change `ownerNumber` by a non-admin. -> REJECTED.
5. **Orphaned User Creation**: Creating a user at a random path like `/hackers/{id}`. -> REJECTED.
6. **Self-Unbanning**: A user attempting to set `banned: false` on their own doc. -> REJECTED.
7. **Identity Spoofing**: Attempting to create a document for another user ID without permissions. -> REJECTED.
8. **Large Payload**: Attempting to write a 1MB string into the `points` field. -> REJECTED.
9. **Malformed ID**: Using `{userId}` with illegal characters. -> REJECTED.
10. **State Skipping**: Incrementing `warnings` by 10 in one go through the client. -> REJECTED.
11. **PII Leak**: Unauthenticated read of user warnings/points. -> REJECTED.
12. **System Field Modification**: Modifying `botNumber` in settings without admin rights. -> REJECTED.

## 3. Test Runner (Mock)
A `firestore.rules.test.ts` would typically use the `@firebase/rules-unit-testing` library to verify these.
Since my primary interaction is through the bot code (server-side), I will ensure the Rules are strict.
