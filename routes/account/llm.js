import express from 'express'
import { runLlm } from '../../services/llm.js'

const router = express.Router()

// GET /  — 没有专门的 LLM 主页,转回凭证列表
router.get('/', (req, res) => {
  res.redirect('/account/credentials')
})

/**
 * GET /account/llm/ping
 * 一次性 LLM 调用诊断:用用户绑的凭证发送最小消息,验证整条链路。
 *
 * Query:
 *   ?provider=anthropic|openai  (可选)
 *   ?authType=api_key|oauth      (可选)
 *   ?credentialId=cred_xxx       (可选,指定具体凭证)
 *   ?model=heavy|light|<具体>    (可选)
 */
router.get('/ping', async (req, res) => {
  const db = req.app.locals.db
  const started = Date.now()
  const result = await runLlm(db, {
    userId: req.user.id,
    actionType: 'ping',
    prompt: 'Reply with just the two characters: OK',
    maxTokens: 16,
    preferredProvider: req.query.provider || null,
    preferredAuthType: req.query.authType || null,
    credentialId: req.query.credentialId || null,
    model: req.query.model || 'light',
    timeoutMs: 60_000,
  })
  const totalMs = Date.now() - started

  res.json({
    ...result,
    text: typeof result.text === 'string' ? result.text.slice(0, 500) : undefined,
    error: typeof result.error === 'string' ? result.error.slice(0, 500) : undefined,
    totalMs,
  })
})

export default router
