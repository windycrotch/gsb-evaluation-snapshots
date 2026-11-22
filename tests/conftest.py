"""pytest 公共配置：把仓库根目录加入 sys.path，保证 ``import streaming`` /
``import bytetrack`` 在不安装包的情况下可用（测试以 ``python -I -m pytest``
运行时 cwd 不会自动进 sys.path）。
"""

import os
import sys

# tests/ 的上一级才是仓库根目录（streaming/、bytetrack/ 所在位置）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
