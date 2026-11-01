#!/usr/bin/env python3
"""把 ima 技能装进 WorkBuddy，并写好 MCP 配置。

只用标准库，不需要 Node，不需要构建。

    python scripts/install-workbuddy.py \
        --url https://your-site/bridge/v1/mcp \
        --service-token XXX --bridge-token YYY

默认写到 ~/.workbuddy/mcp.json 和 ~/.workbuddy/skills/ima-cloud；
已有的其他 MCP 服务会保留，原文件先备份为 mcp.json.bak。
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

SKILL_NAME = 'ima-cloud'
SERVER_NAME = 'yushu-ima'


def fail(message):
    print('错误：' + message, file=sys.stderr)
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description='安装 ima 技能到 WorkBuddy')
    parser.add_argument('--url', required=True, help='服务 MCP 地址，形如 https://站点/bridge/v1/mcp')
    parser.add_argument('--service-token', required=True, help='外层网关令牌')
    parser.add_argument('--bridge-token', required=True, help='内部桥令牌')
    parser.add_argument('--config', help='mcp.json 路径，默认 ~/.workbuddy/mcp.json')
    parser.add_argument('--skills-dir', help='技能目录，默认 ~/.workbuddy/skills')
    parser.add_argument('--force', action='store_true', help='技能已存在时覆盖')
    parser.add_argument('--dry-run', action='store_true', help='只打印将要做什么，不写文件')
    args = parser.parse_args()

    repo = Path(__file__).resolve().parent.parent
    skill_src = repo / 'workbuddy' / 'skills' / SKILL_NAME
    agent = repo / 'agent' / 'ima_agent.py'
    if not skill_src.is_dir():
        fail('找不到技能目录 %s，请在仓库根目录运行' % skill_src)
    if not agent.is_file():
        fail('找不到接入器 %s，请在仓库根目录运行' % agent)

    base = Path.home() / '.workbuddy'
    config = Path(args.config).expanduser() if args.config else base / 'mcp.json'
    skills_dir = Path(args.skills_dir).expanduser() if args.skills_dir else base / 'skills'
    skill_dst = skills_dir / SKILL_NAME

    if skill_dst.exists() and not args.force and not args.dry_run:
        fail('技能已存在：%s（要覆盖请加 --force）' % skill_dst)

    print('技能目录：%s' % skill_dst)
    print('配置文件：%s' % config)
    print('接入器　：%s' % agent)
    print('服务地址：%s' % args.url)

    if args.dry_run:
        print('\n[dry-run] 未写入任何文件')
        return

    if skill_dst.exists():
        shutil.rmtree(skill_dst)
    skills_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(skill_src, skill_dst)

    config.parent.mkdir(parents=True, exist_ok=True)
    data = {}
    if config.exists():
        try:
            data = json.loads(config.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            fail('现有的 %s 不是合法 JSON，先修好再运行' % config)
        backup = config.with_name(config.name + '.bak')
        shutil.copy2(config, backup)
        print('已备份原配置：%s' % backup)

    servers = data.setdefault('mcpServers', {})
    servers[SERVER_NAME] = {
        'command': sys.executable or 'python',
        'args': [str(agent), 'stdio'],
        'env': {
            'IMA_MCP_URL': args.url,
            'IMA_CLOUD_SERVICE_TOKEN': args.service_token,
            'IMA_CLOUD_BRIDGE_TOKEN': args.bridge_token,
            'IMA_CLOUD_TIMEOUT': '120',
        },
    }
    config.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    print('\n完成。接下来：')
    print('1. 重开一轮 WorkBuddy 对话')
    print('2. 在自定义连接器里信任 %s' % SERVER_NAME)
    print('3. 说一句「查一下我的知识库里有哪些目录」验证')


if __name__ == '__main__':
    main()
