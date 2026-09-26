# エージェントのジョブは、index の設定が git に見させないファイルも含めて、worktree をディスクにあるとおりにコミットする

worktree で隔離したジョブが終わると、ASIST はエージェントが残した worktree を、ファイルがディスクにあるとおりにコミットする。git には、ファイルを見ずに済ませるための設定がある。リポジトリの core.ignoreStat が有効だと、git は worktree を作ったときにすべてのファイルに assume-unchanged を付ける。エージェント自身も update-index で assume-unchanged や skip-worktree を付けられる。fsmonitor のフックは変更の通知を取りこぼすことがある。これらをそのまま信じて読むと、編集が見えないままジョブは変更なしとして片付けられ、worktree と一緒に編集が消える。そこで、ジョブの worktree の index からだけ assume-unchanged を外し、core.ignoreStat と fsmonitor を切った git で読む。利用者のリポジトリの index と設定は変えない。skip-worktree は、sparse checkout が取り出さないファイルに git が付ける設定でもある。sparse でない worktree でこれを付けるのはエージェントだけなので、すべて外す。sparse の worktree では、ディスクにあるファイルからだけ外し、無いファイルは取り出していないだけとして削除には数えない。範囲の外に書いたファイルもコミットに含める。sparse checkout の範囲の中にあるのに無く、skip-worktree が付いているファイルは、エージェントが削除を隠したのか、範囲を変えたあとに取り出し直していないだけなのかを見分けられない。そのときはコミットせずに worktree を残し、理由をジョブのログに出す。

## 見送った案

- **リポジトリと index の設定をそのまま信じて読む。** 編集が見えないまま worktree を消すので、エージェントの作業が失われる。
- **sparse の worktree でも skip-worktree をすべて外す。** 取り出していないファイルがすべて削除としてコミットされる。
- **sparse checkout のリポジトリではジョブを片付けない。** sparse のリポジトリでは、どのジョブも取り込めなくなる。
- **範囲の中にあって無いファイルを削除として扱う。** 範囲を変えて取り出し直していないだけのときに、エージェントがしていない削除を取り込み待ちにしてしまう。
- **worktree で git sparse-checkout reapply をしてから読む。** worktree のファイルを書き換えるので、エージェントが消したファイルが戻り、エージェントが残したものとは違うものをコミットする。

## 分かっている制約

- 範囲の中にあって無いファイルがあるジョブは、利用者が worktree で取り出し直すか、削除として扱うように直すまで片付かない。
