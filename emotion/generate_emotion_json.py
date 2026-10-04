#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_emotion_json.py
根据指定目录生成 Twikoo 可用的 OwO 表情 JSON 文件。

用法示例：
    python generate_emotion_json.py ./emotions -o owo.json -b https://your-cdn.com/emotions/

    generate_emotion_json.py ./arc-hikari -o owo.json -b https://blogofhikari.pages.dev/emotion/arc-hikari/ -c "Arc同人表情-光光"
"""

import argparse
import json
import os
import re
from pathlib import Path
from urllib.parse import quote

IMAGE_EXTENSIONS = {'.gif', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.svg'}


def natural_sort_key(s):
    """自然排序：2 排在 10 前面"""
    return [int(text) if text.isdigit() else text.lower()
            for text in re.split(r'(\d+)', str(s))]


def is_image_file(filename):
    return Path(filename).suffix.lower() in IMAGE_EXTENSIONS


def make_icon(url, referrerpolicy=None):
    """生成 <img src="..."> 格式的 icon，可选 referrerpolicy"""
    if referrerpolicy:
        return f'<img src="{url}" referrerpolicy="{referrerpolicy}">'
    return f'<img src="{url}">'


def build_container(image_dir, base_url, encode=True, referrerpolicy=None):
    """扫描目录下的图片，构建 container 列表"""
    container = []
    files = [f for f in os.listdir(image_dir) if is_image_file(f)]
    files.sort(key=natural_sort_key)

    for f in files:
        text = Path(f).stem  # 表情名称 = 文件名（不含扩展名）
        # URL 编码，保留中文可读性可自行关闭
        safe_name = quote(f, safe='') if encode else f

        if base_url:
            if not base_url.endswith('/'):
                base_url += '/'
            url = base_url + safe_name
        else:
            url = safe_name

        container.append({
            "icon": make_icon(url, referrerpolicy),
            "text": text
        })
    return container


def main():
    parser = argparse.ArgumentParser(
        description='根据图片目录生成 Twikoo OwO 表情 JSON 文件'
    )
    parser.add_argument('input_dir', help='包含表情图片的目录')
    parser.add_argument('-o', '--output', default='owo.json', help='输出 JSON 路径')
    parser.add_argument('-b', '--base-url', default='',
                        help='图片基础 URL，例如 https://blogofhikari.pages.dev/emotion/arc-hikari/')
    parser.add_argument('-c', '--category', default=None,
                        help='表情分类名称，默认使用目录名')
    parser.add_argument('--no-encode', action='store_true',
                        help='不对文件名进行 URL 编码')
    parser.add_argument('--referrerpolicy', default=None,
                        help='为 <img> 添加 referrerpolicy 属性，如 no-referrer')
    args = parser.parse_args()

    input_dir = Path(args.input_dir).resolve()
    if not input_dir.is_dir():
        print(f"错误：{input_dir} 不是有效目录")
        return 1

    category = args.category or input_dir.name
    encode = not args.no_encode

    container = build_container(
        input_dir, args.base_url, encode, args.referrerpolicy
    )

    if not container:
        print("警告：目录中没有找到图片文件")
        return 1

    result = {
        category: {
            "type": "image",
            "container": container
        }
    }

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"✅ 已生成：{Path(args.output).resolve()}")
    print(f"📦 分类：{category}，共 {len(container)} 个表情")
    return 0


if __name__ == '__main__':
    exit(main())