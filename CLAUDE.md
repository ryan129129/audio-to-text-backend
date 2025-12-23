# Claude Code 项目指南

## 语言规范

- 代码注释使用中文
- 与用户对话使用中文

## 部署流程

- 提交代码到 `main` 分支会自动触发 Cloud Build 构建和部署
- 如果需要手动更新 Cloud Run 服务，请先询问用户确认

## 项目结构

- `src/` - NestJS 后端源码
- `docs/` - 项目文档
- `supabase/` - Supabase 数据库迁移
- `cloudbuild.yaml` - Cloud Build 配置

## 相关文档

- [YouTube 转录流程](docs/youtube-transcription-flow.md)
