// FCM（Android 套壳）—— Phase 2 实做。Phase 1 为 stub：APK 靠轮询兜底。
//
// 实做时需要：Firebase 项目 service account（HTTP v1 API）或 legacy server key，
// 经 https://fcm.googleapis.com/v1/projects/<id>/messages:send 发 data 消息。
// APK 端需集成 Firebase Messaging 上报 device token 到 /api/push/subscribe (channel:'fcm')。
// ⚠️ 大陆 FCM 通道不稳，轮询仍是最可靠路径。

export async function sendFcm(_env, _subscription, _payload) {
    return { ok: false, gone: false, reason: 'fcm-not-implemented (Phase 2)' };
}
