# Scope 护栏

来源：owner 2026-09-01 立规（三仓 reviewer 齐抓越界：zhoukun/lex/shaoquan）。

1. 开工先写下本单 scope（仓+目录白名单），diff 出白名单即停手 NEEDSIG——顺手修/顺手清一律禁止。
2. CI/workflow、.env、eslint 规则、他人 feature 目录（哪怕只删一行）＝永远出 scope，需单独开 PR 走对应 owner。
3. 交付前自查 `git diff --name-only <base>...HEAD` 逐行核对白名单，越界文件出现在交付里=直接 FAIL。
4. 别人注释里写着「XX 前删掉/由 XX 处理」的代码=别人的排期，绝不代删。
