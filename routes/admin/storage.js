/**
 * /admin/storage — 储存空间监控 + 孤儿文件清理
 *
 * GET  /admin/storage                  概览 + 用户/项目占用 Top 排行 + 孤儿列表
 * POST /admin/storage/cleanup-orphans  批量删孤儿(危险,POST + confirm)
 * POST /admin/storage/refresh          就是 GET 一遍刷新(用 redirect)
 */

import express from 'express'
import {
  getPlatformStorage,
  getProjectStorage,
  getUserStorage,
  listOrphanFiles,
  deleteOrphans,
  getDbStats,
  formatBytes,
} from '../../services/storage.js'
import { audit } from '../../services/audit.js'

const router = express.Router()

router.get('/', (req, res) => {
  const db = req.app.locals.db
  const platform = getPlatformStorage(db)
  const dbStats = getDbStats(db)
  const orphans = listOrphanFiles(db)
  const orphanTotal = orphans.reduce((s, o) => s + o.bytes, 0)

  // 用户 Top:按总占用排序前 10
  const users = db.prepare('SELECT id, email FROM users WHERE is_active = 1').all()
  const userUsage = users.map((u) => {
    const s = getUserStorage(db, u.id)
    return {
      id: u.id, email: u.email,
      bytes: s.total_bytes,
      project_count: s.project_count,
      projects_bytes: s.projects_bytes,
      oauth_bytes: s.oauth_home_bytes,
      data_rows: s.data_rows_total || { records: 0, screening: 0, extractions: 0, themes: 0, draft_sections: 0 },
    }
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 10)

  // 项目 Top:全平台按占用排前 15(扫盘,百级项目可接受)
  const allProjects = db.prepare(
    `SELECT p.id, p.title, p.user_id, u.email AS owner_email
     FROM projects p LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.updated_at DESC`
  ).all()
  const projectUsage = allProjects.map((p) => {
    const s = getProjectStorage(db, p.id)
    return { ...p, bytes: s.total_bytes, attach_total: s.attachments.total, attach_missing: s.attachments.missing, counts: s.counts }
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 15)

  audit(db, req, {
    eventType: 'admin_viewed_storage',
    userId: req.user.id,
    payload: { orphan_count: orphans.length, orphan_bytes: orphanTotal },
  })

  res.render('admin/storage', {
    title: '储存空间',
    platform,
    dbStats,
    orphans,
    orphanTotal,
    userUsage,
    projectUsage,
    formatBytes,
  })
})

router.post('/cleanup-orphans', (req, res) => {
  const db = req.app.locals.db
  const orphans = listOrphanFiles(db)
  const { removed, errors } = deleteOrphans(orphans)

  audit(db, req, {
    eventType: 'admin_cleanup_orphans',
    userId: req.user.id,
    payload: {
      removed_count: removed.length,
      error_count: errors.length,
      paths_removed: removed.slice(0, 30),
      errors: errors.slice(0, 10),
    },
  })

  req.session.flash = {
    type: errors.length === 0 ? 'success' : 'error',
    message: `孤儿清理:删了 ${removed.length} 项${errors.length ? ',失败 ' + errors.length + ' 项' : ''}`,
  }
  res.redirect('/admin/storage')
})

export default router
