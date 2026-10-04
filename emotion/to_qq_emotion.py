import json
import urllib.request

src = "https://raw.githubusercontent.com/noionion/Twikoo-Magic/refs/heads/master/Classification/QQ/QQ.json"

with urllib.request.urlopen(src) as r:
    data = json.load(r)

# 原文件如果顶层就是 {"QQ": {...}}，直接保留
# 如果想改分类名，就改成 "QQ官方表情"
out = {
    "QQ官方表情": data["QQ"]
}

with open("owo.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print("已生成 owo.json，图片 URL 全部保留原文件内容")