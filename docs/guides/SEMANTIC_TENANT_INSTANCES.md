# Semantica 独立租户实例接入

## 独立模型的连接器边界（2026-10-19）

独立模型登记、发布结构或配置显式模型授权，都不等于完成业务数据源绑定。现有旧版连接器按系统码读取共享配置，尚无模型级来源绑定与回执证明，因此仅支持默认模型路径。独立模型调用该传输层时，在读取连接配置、解析凭据和发起网络请求之前返回`ONTOLOGY_CONNECTOR_MODEL_BINDING_REQUIRED`，不能借用默认模型的WMS/ERP连接器。

默认模型的调用仍须具有合法租户/主体，且租户必须与服务端当前上下文一致；不一致返回`ONTOLOGY_CONNECTOR_SCOPE_INVALID`。未绑定上下文仅保留原有本机Demo约定，生产环境原有租户上下文门禁不变。此检查不替代上层对象/字段权限、记录分级和读取返回前撤权复验。

后续业务运行仍需实现模型级来源/连接配置绑定、版本化回执与授权复验，再开放独立模型事实读取。不得通过移除`runtimeReadEnabled=false`或给旧请求体追加modelId来冒充绑定完成。当前本地合成回放和固定版本结构咨询不受影响，也不因此获得真实业务读取能力。

## 新建固定版本的结构咨询（2026-10-18）

在智脑“知识资料”读取授权模型目录并选择模型图，勾选“我确认新建固定此版本的结构咨询”，点击“新建结构咨询会话”。进入主聊天后会固定显示modelId和发布版本；已有普通业务任务不改变。它不是原业务主聊天的模型切换，所以目录`chatSelectionEnabled=false`及`runtimeReadEnabled=false`仍保留。

可以问“解释批次对象的来源和关系”“它的主键和字段是什么”“不是批次，而是供应商对象”。当前仅按已发布对象名称/稳定编码匹配，最多三个对象；歧义或范围过大需明确编码，不保证任意口语、语义别名或复杂问题都能理解。关系按发布的声明方向展示，不推断因果、等价或业务记录。每对象通常展示前8条关系，明确问关系/系统时前20条并披露剩余数；完整结构可回到图查看。

所有答案从发布结构确定性渲染，运行标识`deterministic_schema`、`provider=none`，不调用大模型、Python或业务连接器。实时数据、文件生成、修改、发布等请求会说明超出范围，不会回退默认业务模型。大答复同时按原文和历史Unicode规范化后的长度预算保留完整行，7200字符以内；未展示部分会明确提示回到结构图查看，不伪称全部解释完成，也不依赖存储端静默截断。上传材料入口在此模式隐藏，服务端也拒绝附件。语音转写仅作为同一条文字问题，不授予新能力。

API：POST `/api/agent/published-models/{modelId}/conversations`，SDK：`createModelConversation(modelId,{confirmed:true,expectedVersion,expectedFingerprint})`；版本/指纹来自刚读取的定义。新会话返回不可变`agent-model-binding.v1`（mode=published_schema_only）。普通`/agent/conversations`不能夹带绑定；`/agent/message`仅提交此conversationId及文字，消息中的modelId/modelBinding/modelVersion/modelFingerprint拒绝，不支持临时换模。新模型或新版本需要另建会话。

每轮复验当前授权与发布版本。旧版本会话仍保留历史，但不能继续用新版本解释旧问题；撤权或发布变化不返回新的旧成功。消息写入按已读会话修订CAS，防止并发请求覆盖对象焦点；不混入普通业务历史、全局个人记忆或其他模型。禁止将结构咨询固定为全局任务记忆、关联业务执行或撤销，即使已归档也不允许。

若创建/保存回执不确定，可能已写入本地，会返回`conversationMayHaveCommitted=true`。不要自动重发，请刷新自己的任务列表/原会话核对；创建不是请求号幂等恢复，不能把手动再点视为不会重复创建。权限库、发布库及会话库仍非跨库原子事务，写后拒绝可能已有本地记录，界面不冒称回滚。

## 智脑查看已发布独立模型（2026-10-18）

进入智脑“知识资料”，点击“读取授权模型目录”，再点击某个模型查看已发布关系图。可以查看对象、主键、字段名及来源系统，使用现有图谱的搜索/定位；图内不能保存布局、直接提问、切换当前业务问答模型或执行。上方可以另建限定结构咨询，规则见本页首节。刷新、切换账号或读取失败会清除旧内容；目录与详情版本不一致需重新读取目录。此界面不会自动把整张模型图送给大模型。

API为GET `/api/agent/published-models`和GET `/api/agent/published-models/{modelId}`，SDK为`publishedModels()`、`publishedModel(modelId)`。只接受路径选择，不接受查询参数、POST或身份/角色覆盖；当前默认工作区仍走既有主工作台，不在此独立目录重复展示。返回`runtimeReadEnabled=false`及`chatSelectionEnabled=false`，明确区别于未来的业务运行选择。

平台人员需要在服务端显式模型授权中配置metadata（下面仅合成示意，不是项目已为真实企业配置）：

```json
{
  "synthetic-enterprise": {
    "quality_manager": {
      "models": {
        "quality-model": {
          "schemaVersion": "ontology-model-grant.v1",
          "modelId": "quality-model",
          "metadata": true,
          "objects": {}
        }
      }
    }
  }
}
```

`ONTOLOGY_RUNTIME_GRANTS_JSON`中的metadata=true明确授予该模型已发布结构名称、字段名和来源码的查看权，不授予对象实例查询；objects为空时仍不能读业务事实。角色必须来自当前有效IAM主体，并具备`page.agent.view`与`agent.prompt.run`，不能靠请求头伪造。默认模型的metadata/objects授权不会继承。此入口不绕过受管租户运行准入门禁。

模型还须已登记、发布原始记录明确绑定当前租户和modelId，指纹正确且与完成发布锁一致；发布完成锁只用于结构来源核对，不是实时服务健康/业务运行证明。最多31个独立模型、单图200对象/400关系、每对象100字段，原始发布定义512KiB与结构投影256KiB预算；超预算或坏引用拒绝整包，不截断冒充完整图。实例、规则表达式、连接配置、部署标识和凭据均不返回。

新发布会在原始记录保存真实modelId。旧版本若缺少这个字段，读取器不根据所在文件/当前上下文补造归属：请运营人员先核对原模型、目标和版本，再经受控流程重新发布。该项不自动迁移历史，也不启用主聊天多模型业务查询。权限库和模型库仍为分离存储，本轮两轮记录复验与末尾新鲜IAM检查不是跨库原子事务。

## 模型任务化合成模拟（2026-10-18）

在“独立模型任务工作区”选择模型，将“本地任务类型”设为“合成模拟”，分别勾选并执行创建、确认、执行三个步骤。只创建不会运行；确认只签发凭证；执行才生成本地合成实例和回放。需要当前管理层、语义运营页面及模拟权限，任务仅当前所有者操作。既有校验任务和结构化候选采纳保留独立入口，不能混用命令或凭证。

HTTP和SDK对应：

| 动作 | 指定模型下的路径 | SDK |
| --- | --- | --- |
| 创建 | POST `/api/semantic-operations/models/{modelId}/local-simulation-tasks` | `createLocalSimulationTask(modelId,body)` |
| 确认 | POST `/api/semantic-operations/models/{modelId}/tasks/{taskId}/simulation-confirm` | `confirmLocalSimulationTask(modelId,taskId,body)` |
| 执行 | POST `/api/semantic-operations/models/{modelId}/tasks/{taskId}/simulation-execute` | `executeLocalSimulationTask(modelId,taskId,body)` |
| 既有确认证据恢复 | POST `/api/semantic-operations/models/{modelId}/tasks/{taskId}/simulation-evidence-recover` | `recoverLocalSimulationEvidence(modelId,taskId,{confirmed:true})` |

创建载荷为`confirmed=true`、`kind=simulate_model`、小写UUID v4 `requestId`及GET本模型draft得到的`expectedDraftFingerprint`。确认使用最新`taskFingerprint`，执行使用确认回执的`taskFingerprint`与`confirmationToken`。路径不接受查询覆盖，载荷不接受额外命令、身份或模型参数。旧草稿使凭证失效，执行写事务再次核对原指纹；必须重新核对并创建新任务，不能用旧凭证执行新草稿。

凭证只保存在页面内存，换模型/任务/权限或失败后清除。未知创建结果可使用原请求号明确恢复，不自动创建第二条；确认证据pending时只恢复原证据，不重签或执行。已就绪证据丢失时阻断，不补造成功历史。执行回执不确定时先读取原任务，不自动再次执行。

结果含`sourceFingerprint`、`sourceMode=synthetic`、`verifiesLiveSystems=false`、校验摘要及节点/关系数；完成任务的摘要和对话读取也带同一有界统计，不含实例记录。工作台刷新后可查看。此入口只运行Node本地合成模拟，不调用Python Semantica、收费模型、上游或真实企业数据；不是生产仿真、发布成功或智脑独立模型读取已启用。旧阶段下述“任务模拟待补”由此限定子项补齐，其他范围保持原门禁。

## 内部结构化候选预览基础（2026-10-12）

2026-10-13读取授权隔离基础：服务端ONTOLOGY_RUNTIME_GRANTS_JSON的旧`tenant→role`授权只兼容默认模型。独立模型需要该角色下的`models[modelId]`显式配置，包含schemaVersion=ontology-model-grant.v1、同modelId、metadata=true和独立objects对象；未知参数、跨租户、未登记上下文或错模型拒绝，不继承旧objects。这里仅说明开发契约，项目没有代用户添加真实授权；即使具备该配置，当前非默认发布定义仍禁用业务读取，不能仅改JSON绕过运行绑定或数据门禁。

运营端非当前功能页现在按需加载，构建读取实际Vite入口manifest，超过500000字节即失败，不提高原500kB阈值。2026-10-13入口386.40kB；这是入口包大小验证，不代表全部页面冷加载或真实大图性能已验收。

2026-10-13模型审阅/采纳界面：在独立模型任务页主动选择自己的结构化候选，拥有保存与审核权限时显示“先看模型，再确认采纳”。点击“读取当前模型图与差异”，图内选择对象查看来源、主键和字段；下方完整关联列表包含源字段→目标字段、基数和差异。窄屏在图内横向滚动，详情自动单列。结构/样本映射未通过时不能确认，替换模式会明确显示移除项。

核对后单独勾选“只签发确认凭证”并确认，再次勾选“仅采纳到草稿”后复验版本并采纳。采纳后拥有模拟权限者可单独勾选并模拟当前草稿；这是本地合成模拟，不发布、不写上游，也不是智脑业务读取已启用。凭证仅本页内存，刷新/换任务会清除；未知执行结果不重试，应核对原任务和草稿。pending既有确认证据可单独恢复，不重签；恢复后必须重新审阅。

审阅接口为GET `/api/semantic-operations/models/{modelId}/tasks/{taskId}/adoption-review`，SDK reviewAdoptionTask。只返回当前所有者、原版本的有限结构及差异，不返回原样本、材料或凭证；不接受查询/写方法，超限返回413而非截断。关系图目前是有界网格浏览，不承诺复杂大图无交叉或全局最优布局。

2026-10-13受控采纳接口：POST `/api/semantic-operations/models/{modelId}/tasks/{taskId}/adoption-confirm`，body仅confirmed=true和expectedTaskFingerprint；证据ready后返回一次性凭证及新任务指纹。明确再次确认后POST同任务`/adoption-execute`，body增加confirmationToken，只采纳到本系统模型草稿，不模拟/发布/写上游。未知执行回执不得自动重发。既有确认证据可单独POST`/adoption-confirmation-evidence-recover`，body仅confirmed=true，不重签或返回遗失凭证。SDK对应confirmAdoptionTask、executeAdoptionTask、recoverAdoptionConfirmationEvidence；每步重查实际保存/审核双权限及原模型/任务引用，不授予新权限。仅provider=none的结构化预览适用，local-execute仍只校验。采纳用户界面尚未开放，需先接当前版本对象关系图和差异审阅，不把接口成功当完整用户闭环。

2026-10-13服务端内部增加executeAdoptionTask：只接受当前所有者的结构化预览与已就绪证据/一次性确认凭证，核对原任务及草稿版本、实际保存和审核权限，保留Critic/样本验证；只采纳到当前独立模型草稿。合成库存采纳后可用既有modelWorkspaces.simulate显式确认当前草稿版本进行本地模拟，不能视为生产读取。HTTP/SDK/UI采纳尚未开放；local-execute仍只允许validate_model，不能通过请求体指定采纳或发布。

原请求状态可在独立模型页“核对原预览请求”手动查询：选非默认模型，输入原创建时使用的完整小写UUID v4，点击“只读核对状态”。只返回当前身份范围的阶段，不创建新请求、不自动选择任务或续交。占位无快照不能自动重试、接管或删除；已提交也不等于证据已就绪或获得执行授权。改变请求号、模型、身份/权限会清除旧摘要；仅保存在当前页面内存。

来源绑定后填写“生成结构化候选预览”的诉求，单独勾选并创建；该入口只解析来源Schema，不调用大模型或识别图片/语音。创建前核对当前草稿指纹，请求号自动填入状态核对区；未知回执阻止本页第二次发送，请记下编号，不能把刷新页面当失败后重试。

恢复流程按状态分开：prepared先勾选并“检查原准备快照”，再次勾选后“仅续交原任务”；committed勾选“读取原提交回执”；得到pending证据时再次勾选“核验并恢复原任务证据”。每次只执行选定一步，不自动重试、不重新抽取、不签发或执行模型任务。草稿版本或引用变化必须重新检查，未知续交结果先只读核对原编号。受控采纳/模拟/智脑独立模型读取仍未接齐。

运营端“独立模型任务”选择非默认模型后，拥有草稿权限可见“先检查来源，再明确绑定”：输入已有系统码（如WMS, ERP），点击检查，核对资料数量及绑定修订后单独勾选确认绑定。绑定不自动生成候选或执行。改动输入、模型、身份或权限会清除旧摘要和同意；写回执不明时重新检查，不自动重试。候选预览/恢复UI仍待接入。

原请求恢复使用POST `/api/semantic-operations/models/{modelId}/preview-requests/{requestId}/inspect-prepared`、`/resume`、`/recover-commit`，SDK分别为inspectPreparedPreview、resumePreparedPreview、recoverPreviewCommit。body仅含confirmed=true、inputFingerprint、expectedCheckpointFingerprint、expectedDraftFingerprint，不能覆盖路径身份。探针不提交，resume只续交原任务且证据pending，recover-commit只读取原提交摘要；证据仍须单独明确恢复，不签发或执行。POST不自动重试，重复续交拒绝，UI尚待接入，受管门禁未扩大。

明确来源绑定入口：POST `/api/semantic-operations/models/{modelId}/source-materials/inspect`，body为systemCodes，返回资料摘要和当前revision；核对后POST同前缀`/bind`，携带confirmed=true、systemCodes、expectedRevision和expectedSourceFingerprint。SDK对应inspectModelSources/bindModelSources；不返回资料正文，也不授予原来没有的来源权限。旧CAS或资料/权限变化拒绝，绑定回执不明可能已提交，不自动重试POST。默认模型不开放此绑定，受管门禁不扩大；续交/未知提交恢复HTTP和UI仍待补。

POST `/api/semantic-operations/models/{modelId}/structured-preview-tasks`（SDK createStructuredPreview）要求明确确认、稳定UUIDv4、当前草稿指纹、明确已绑定来源码及建模诉求。首次201，同请求同输入且引用仍有效返回原任务200；同号改输入拒绝，POST不自动重试。最多8个附件对象，仍经过现有材料门禁，缺少可解析Schema不转入大模型。ready不意味着采纳、签发或执行。当前来源绑定用户入口、续交/未知提交恢复HTTP与UI仍待补，受管门禁不扩大。

POST `/api/semantic-operations/models/{modelId}/tasks/{taskId}/preview-evidence-recover`（SDK recoverPreviewEvidence）需要confirmed=true及完整expectedTaskFingerprint。只恢复当前所有者/原角色、待确认且未签发的预览任务证据；不签发、采纳或执行，不接受查询覆盖。未知回执应重新读取原任务状态再明确决定，SDK不自动重试POST。创建、续交及未知提交恢复的HTTP/UI仍未开放，受管租户门禁未扩大。

已有请求可通过GET `/api/semantic-operations/models/{modelId}/preview-requests/{requestId}` 查询元数据，SDK为getPreviewRequestStatus。要求当前主体/原角色的管理层IAM、语义运营页面/草稿权限及登记；只接受UUIDv4路径，无查询覆盖或POST。状态不表示已完成引用准入，不准备、恢复或执行。商业受管租户仍受unverified_runtime门禁，不扩大运行时授权；预览创建/恢复HTTP和UI仍待接入。

内部previewRequestStatus通过当前IAM/模型登记查询自己的原请求号：只返回reserved/prepared/committed和输入/检查点摘要、已提交任务号，不返回准备正文。prepared/committed仍核对实际记录并复读，不存在请求404且不创建槽。reserved没有检查点时明确阻塞原因preparation_checkpoint_absent，无法证明旧准备是否仍在运行，因此不自动重试、超时接管、删除占位或声称恢复完成；需保留记录供核对。状态查询不代替实际引用准入，不签发授权，目前没有新用户入口。

续交事务可能已经提交但回执未知时，内部recoverPreviewCommit明确确认原请求/输入/检查点/草稿版本，只读实际committed回执，核对同主体/原角色/模型任务及实际引用、等待后复读，返回原任务摘要和指纹。不会再次提交、补写事件或签发；pending仍需单独明确完成证据。记录缺失或绑定变化拒绝，不新建替代任务，无新用户入口。

续交后的pending任务可明确调用内部recoverPreviewEvidence完成回执：核验原有效证据链、检查点和请求回执、实际引用及完整任务版本后，追加当前恢复观察；缺失的路由/提案核验记录带recoveryObservation，不回填过去时间或宣称原执行发生。幂等事件完成后CAS置ready，仍不签发执行凭证。事件保存后回执丢失仍pending，明确重试不重复事件；原链丢失或损坏不重建。

内部resumePreparedPreview在明确确认原请求/检查点/草稿版本后，两次核对实际引用及新鲜IAM，联合提交原任务和请求回执，保留原任务/证据编号，不重新抽取。续交结果只到pending，不能确认或执行，原事件完成仍待开发。已提交检查点再次续交拒绝，不新建第二条任务；提交后回执未知的专门恢复仍待补，无新用户入口。

内部inspectPreparedPreview组合当前IAM、登记和准备快照读取，核对原草稿版本、实际提案模型/主体/修订、材料/来源绑定和现有证据链，并重复读取检查变化。只返回参考有效性摘要，不返回快照正文、不提交任务，不授予续交或执行。准备后中断的WMS合成候选可以验证；提案修订或证据变化时拒绝。它不是跨仓原子快照，也没有用户入口。

内部loadPreparedTask读取准备快照时，需要原请求号、输入SHA和检查点SHA，按当前主体/原角色/模型推导键；只接受prepared，核对完整任务绑定/摘要及大小，任务号已存在则拒绝，等待后复读。返回的是独立副本，错主体、旧摘要、篡改、已提交或等待中变化均拒绝。它不提供IAM权限或执行能力，实际材料/提案/来源/草稿/证据准入和续交仍须组合实现，不是用户接口。

准备检查点把已形成的受控任务快照存入原请求槽，限定256KiB并绑定完整快照SHA；prepared重复准备禁止，改动快照拒绝。实际内部预览编排在准入复验后保存检查点，联合提交必须匹配同快照，提交后删除冗余准备副本；证据仍另行完成。快照含受控任务内容，存于对应模型/主体仓，不能当成公开摘要。受控续交与原事件完成仍待补，reserved没有快照不自动重试或超时接管。

带创建请求绑定的预览任务，引用检查和证据完成器必须读取实际committed回执，核对模型/主体/原角色、请求号、输入摘要与任务号，并在等待后重读回执和完整任务。回执缺失、错绑或中途修改拒绝，不能仅凭任务上的创建标记恢复ready。不新增任何材料或权限。

已经ready的预览任务实际证据丢失或关联不符时，内部编排会复验并以完整任务CAS隔离为missing；不会重新造历史，恢复入口拒绝，旧确认入口也不能签发。该隔离只改变当前所有者/原角色的预览任务状态，不删除任务或请求回执。准备阶段恢复与缺失事件的其他处置仍不自动开展。

previewModelTask内部编排现在要求稳定UUIDv4请求号，将请求预留与候选任务/回执联合提交串联起来；输入摘要包含附件、显式来源绑定版本和当前草稿指纹。重复请求只有实际任务绑定、权限/引用/证据仍有效才返回同任务，记录丢失拒绝重建；同号改变输入拒绝。尚在准备的占位返回pending，不自动重试或超时接管，准备阶段失败恢复仍待补。当前没有新HTTP/SDK/UI建模入口，不能将内部幂等当成完整用户建模验收。

内部commitPreparedTask可将已预留请求和实际候选任务联合提交：校对模型/主体/原角色/输入摘要，任务记录创建请求号及摘要、证据pending，回执committed绑定任务号；重复提交和任务号碰撞拒绝，不覆盖旧任务。任务服务仅结构化预览可使用该内部扩展。只有这两条记录同事务，实际IAM、准备材料和证据不是原子提交；当前用户编排还未组合请求号/重复回执读取或准备恢复。

预览请求预留原语semanticPreviewRequests按模型和主体隔离，绑定原角色、UUIDv4及输入SHA；并发同请求只有首个允许准备，重复请求返回已占位且不允许再准备，改变输入拒绝。每模型每主体最多200个占位，不删除旧记录，不存正文或凭证。该原语不提供IAM权限，尚未接入实际创建编排或任务/回执联合事务，不能当作用户创建幂等能力；占位不自动超时接管，失败恢复策略待补。

恢复所确认的完整任务指纹会继续传入证据完成器，完成器重新读取后再次核对，再以完整记录CAS写关联。预检与完成器之间发生任务修改时拒绝、保留pending；不是仅在入口检查一次版本，也不是跨仓原子授权。

内部recoverPreviewEvidence允许对已有预览任务明确确认并提交完整任务指纹，只修复已存在、可验证证据的ready关联。要求当前所有者/原角色、未签发且待确认，重新核对实际IAM及来源/提案引用；错绑或缺失证据拒绝，不补造历史，不创建任务，不返回执行凭证。请求幂等和准备阶段恢复尚未实现，仍不可自动重试创建；该恢复不是用户HTTP入口。

任务服务的structuredPreview、提案服务的structuredOnly仅由服务端组合，不是JSON请求中的客户端提供方开关。要求独立建模诉求和可解析字典/API Schema，不处理父任务编辑、聊天、校验或发布；缺少结构化字段明确拒绝，不转入收费模型、自然语言抽取或对象链接。结果显示creationMode=structured_preview、planning.provider=none，不宣称大模型已理解，也不改变现有提供方配置。

beforeTaskCommit为内部准入扩展点，拒绝或等待后登记/来源变化不写任务索引，但材料、证据准备和提案可能已经保留（preparationMayHaveCommitted），不等于原子回滚。

内部previewModelTask现组合新鲜IAM、登记、当前草稿指纹和明确来源绑定，在任务提交前及返回前复验；核对任务引用和实际证据链后以完整任务CAS置ready，仅返回摘要与任务指纹，不授权执行。提案准备后撤权会拒绝插入任务，但不删除准备记录。请求幂等与失败恢复仍待补，不能将失败请求自动重试；目前无新HTTP/SDK/UI建模入口，不能以内部测试代替企业模型质量验收。

## 运营端分步本地校验（2026-10-12）

在“独立模型任务”选模型后，有校验权限可勾选“只创建本地结构校验任务”并点第1步。任务证据ready、自己拥有确认权限时，单独勾选当前任务版本并点第2步，只签发十分钟凭证；再单独勾选执行范围、点第3步，才进行本地结构校验。其他任务仍仅查看，不自动采纳、模拟、发布或执行上游业务。其他页面工作区不受这个模型选择影响。

凭证只存在当前页内存，不展示或保存到浏览器存储；切换任务/模型/身份/权限、刷新/退出均清除，执行尝试前也会清除，不自动重试。确认证据pending时勾选“仅恢复既有确认证据”，恢复不重签/执行，随后刷新当前任务并重新明确确认。未知创建回执时“明确恢复原创建请求”使用同一请求号，不新建第二条；如果离开/切换模型丢弃了原请求，请先检查最新任务列表，不能把未知回执视为安全重建。

这里只是本地结构校验UI，不是完整模型建模/发布工作台，也不是大模型智能验收。当前验证为Vue组件、HTTP联调和Web构建，未做浏览器视觉/本轮原生桌面包验收；下文“只读页无按钮”为此前阶段说明。

## 限定本地校验HTTP与SDK（2026-10-12）

模型路径为`/api/semantic-operations/models/{modelId}`。仅validate_model，严格POST，不接受查询覆盖；创建、确认和执行是三个独立明确动作，不自动连跑。旧通用tasks POST仍关闭。以下接口为限定本地校验入口，此前“仅内部、无HTTP”的阶段说明不覆盖本节；当前页面按钮尚未接入。

| 动作 | POST路径 | SDK | 关键输入 |
| --- | --- | --- | --- |
| 创建待确认任务 | /local-validation-tasks | createLocalValidationTask | confirmed、kind、稳定UUIDv4 requestId、expectedDraftFingerprint |
| 确认并签发凭证 | /tasks/{taskId}/local-confirm | confirmLocalValidationTask | confirmed、当前expectedTaskFingerprint |
| 执行本地结构校验 | /tasks/{taskId}/local-execute | executeLocalValidationTask | confirmed、确认后新expectedTaskFingerprint、confirmationToken |
| 恢复既有确认证据 | /tasks/{taskId}/confirmation-evidence-recover | recoverLocalConfirmationEvidence | 只传confirmed=true |

创建返回当前taskFingerprint；确认完成证据后返回新的taskFingerprint及十分钟一次性凭证，执行必须用新指纹。所有者对话GET也可读取当前任务指纹。恢复不执行、不重签或找回遗失凭证。错误中的evidencePending/taskMayHaveCommitted/workspaceWriteMayHaveCommitted需要核对最新状态；SDK不会自动重试POST，不能把未知回执当作安全重发。确认/恢复只接受本地校验任务，其他建模、采纳、模拟、发布命令仍拒绝。

已用本机合成IAM两租户完成HTTP闭环，不是企业生产验收；商业受管租户仍受unverified_runtime闸门限制，没有因为新增接口扩大运行时授权。

## 内部限定本地任务创建（2026-10-12）

createLocalTask只允许kind=validate_model，传confirmed=true、稳定UUIDv4 requestId、当前草稿expectedDraftFingerprint。不接受自然语言、附件、来源或其他命令，不调用大模型；仅建立待确认本地校验任务。任务/草稿联合事务核对结构指纹，按模型/主体/请求号幂等，同请求不会新增第二条任务。每模型200条记录满额拒绝（含终态和归档），不删除历史以腾空间。

任务事务先预留pending证据，证据初始化/创建事件幂等并以完整任务CAS置ready。SEMANTIC_LOCAL_TASK_EVIDENCE_PENDING表示任务可能已提交：同一请求号/原结构依据重试，只恢复原证据；已就绪证据丢失不悄悄重建历史。成功返回摘要及完整taskFingerprint，后续仍要明确确认签发凭证、再明确执行；创建不等于确认或执行。此项目前内部使用，HTTP/SDK/UI入口待组合，原只读页没有新建按钮。

## 内部本地校验执行（2026-10-12）

executeTask当前只接受validate_model任务，且只给所有者使用。需要confirmed=true、当前完整任务expectedTaskFingerprint、十分钟一次性confirmationToken，并要求任务及确认证据均ready；消费前/命令前/归档前检查IAM、登记与关联引用，消费事务内核对完整任务指纹。发布、采纳、模拟等命令仍明确拒绝，不调用提供方、Python或源系统，不是完整执行API。

旧指纹、消费前任务/权限变化不消费凭证；消费后失败则可能已经消费凭证或写入本地校验结果，taskMayHaveCommitted/workspaceWriteMayHaveCommitted不能解释为回滚。先检查最新任务和工作区状态，不自动重试。返回仅任务摘要与校验状态，没有凭证/租约/草稿正文；此项仍无新HTTP/SDK/UI动作，原只读页不提供执行按钮。

## 内部任务确认准入（2026-10-12）

新内部入口现在等待确认证据：签发记录先为confirmation.evidenceState=pending，证据事件与状态完成、完整任务CAS标ready后才返回凭证。SEMANTIC_CONFIRMATION_EVIDENCE_PENDING表示签发可能已提交，但未返回凭证；pending阻止重新签发和执行，执行不消费凭证。内部recoverConfirmationEvidence只恢复这次签发的证据，幂等、不重新签发/执行，也无法找回未送达的原凭证；恢复后若需新凭证，读取最新任务指纹并再次明确确认，不能自动重试。

任务摘要及只读页区分任务证据和确认证据；ready是证据就绪，pending是未完成，not_required_or_legacy/legacy_async表示旧调用或未要求新回执，不当成已完成的新证据流程。两阶段任务/证据存储仍分开，不能声称跨库原子提交；旧任务调用的异步追加没有被全面替换。

服务端内部confirmTask要求confirmed=true及expectedTaskFingerprint。后者是完整存储任务JSON的SHA摘要前24位，不能用语义模型结构指纹代替；对外只读页尚未提供确认操作。仅所有者、新鲜IAM、登记和全部关联引用通过且证据ready时允许签发，原Critic/映射、审核指派、草稿和提案版本检查仍执行；十分钟一次性凭证不表示已经执行任务。

任务变化拒绝签发；签发前复验引用/IAM，事务内复验任务指纹。若签发后撤权或准入失败，服务端隐藏凭证并可能提示taskMayHaveCommitted，不能假设任务被回滚；先核对最新记录，不能自动重试或执行。此项无新HTTP/SDK/UI确认入口，创建/执行仍待开发，不是IAM与存储跨仓原子授权。

## 运营端查看独立模型任务（2026-10-12）

管理层登录后，在左侧选择“独立模型任务”，下拉选择已登记模型，再点击任务查看自己的对话。进入页面不会自动选模型；“加载更多”按20条分页读取，任务列表独立滚动。审核者可看到其权限范围的摘要，但不能据此打开作者对话。刷新模型列表会清空旧选择；权限/引用读取失败也清空旧内容，可检查登录身份后重新刷新。

此页仅查看，没有新建、审核确认、执行或发布按钮；也不会改变其他页面的默认工作区。其他页面的Agent、模型图、版本和知识操作仍是原工作区，不能当成对这个下拉所选模型的操作。所选模型没有记录时为空，不回退到默认模型。小屏采用上下布局；当前验证为Vue组件和Web构建，不是浏览器视觉或原生桌面包验收。

## 限定任务对话读取（2026-10-12）

GET `/api/semantic-operations/models/{modelId}/tasks/{taskId}/dialogue`，SDK `modelTaskDialogue(modelId, taskId)`。必须明确当前登记模型；仅任务所有者可读，审核指派不授予作者对话权限。服务端新鲜IAM、登记及任务/提案/材料/来源绑定/项目交接/ready证据复验后返回任务摘要和user/assistant消息（role、content、可选time），不会返回附件、来源发现、提案全文、执行结果、确认凭证或证据正文。

最多64条消息、每条8192字符、投影总量128KiB，超限或格式不支持返回413；不接受查询参数、POST或全局模型请求头选择。消息正文可能包含用户原输入和此前答案，不等于自动脱敏。contentScope为owner_dialogue_only，executionEnabled与runtimeReadEnabled均为false；pending证据仍未就绪，读取不等于可以确认/执行。原任务元数据接口保持不返回对话。运营端模型选择UI和新模型完整任务工作流继续开发。

## 内部任务引用检查（2026-10-12）

交接引用续轮：带onboardingSource或实际提案onboardingBasis的任务还要检查当前人员/原角色的真实项目、模型、材料文本摘要/修订、当前连接/对齐、basis和交接回执任务/提案编号。准备完成后交接事务会递增项目修订，检查要求项目已越过basisRevision，不是简单相等。MODEL_TASK_ONBOARDING_CHANGED表示项目/交接证明不再成立；应核对最新项目，不能重写任务中的来源键、修订或指纹。等待后再检查项目，仍不返回正文、不发起业务动作。

续轮新增材料和来源绑定检查：材料必须归当前人员、原始角色及当前模型，非默认模型读取核对名称/MIME/文本的引用摘要，读取文本总量最多2MiB。前后重载材料并复验当前人员的系统来源权限、绑定修订及来源指纹；审核指派不能继承作者私有材料。MODEL_TASK_MATERIAL_INVALID或MODEL_TASK_SOURCE_CHANGED应先核对原材料/绑定，不尝试绕过或换主体。默认旧文本仍兼容；这仍是内部探针而非HTTP入口或执行许可，也不是跨仓原子快照。

服务端内部inspectTaskReferences仅返回引用范围、状态、祖先数量及证据状态。它按新鲜IAM和登记模型检查任务祖先/线程根、实际提案修订与ready证据，超32条、循环、跨模型/所有者、记录变化或撤权均拒绝。不会返回聊天、来源或证据正文，没有HTTP/SDK入口。referenceState=valid只代表列明范围通过；pending证据、项目basis和操作授权不能由这个结果代替，新任务完整入口继续关闭。

## 交接任务证据与恢复（2026-10-12）

新交接任务预留固定traceId，证据状态先为pending。项目、提案与任务事务完成后补写证据；成功返回evidenceState=ready。若收到SEMANTIC_HANDOFF_EVIDENCE_PENDING/evidencePending=true/taskMayHaveCommitted=true，不应重新建项目或任务：先重新读取项目修订，再按当前expectedRevision重试交接，恢复同一任务和证据编号。事件幂等，重复请求不增加交接事件；已完成证据不降级。

pending/missing证据禁止确认和执行。ready任务在执行前仍复验证据的模型、主体、角色及请求关联，消费凭证时核对预检编号。已就绪证据若丢失，执行不消费凭证，重试不悄悄重建过去记录；需要核对存储/保留状态。旧任务本来没有traceId时可以补建，并用backfilled标明只依据已有交接记录，不伪造过去执行历史。

交接事务与证据存储是分开的，不是跨库原子提交；部分失败会保留已提交任务。Mock响应丢失、重复恢复、旧记录补建和证据丢失拒绝已测试。新模型任务完整用户HTTP/UI仍未开放，下面“交接任务traceId=null”为历史阶段说明。

## 已绑定模型的Mock项目受控交接（2026-10-12）

内部handoff现可用于真正创建在当前模型中的Mock项目。先完成五类资料、连接和带材料引用的人工业务对齐，再明确expectedRevision交接。任务准备读取实际项目校验模型/人员/角色、项目和材料修订、连接/对齐及basis；事务重读项目后一起写入交接回执、提案和任务。后续明确确认采纳仍核对实际项目模型与basis，不发布或写回上游。

未就绪项目返回MOCK_HANDOFF_NOT_READY；旧/跨模型项目或伪造的准备证明仍拒绝。重复交接仅复用完整同模型关联，任务或提案丢失返回MOCK_HANDOFF_REFERENCE_STALE，不自动重建。资料变化需重新验证，旧提案不能采纳。默认模型原流程保持，下面“所有独立模型handoff关闭”为旧阶段说明。

两个模型完整合成资料链已实际测试，包括资料修改、登记撤销和关联丢失拒绝。仍没有新模型项目/任务HTTP/UI入口；交接任务暂沿用无traceId的旧行为，证据链待下一组补齐。事务只覆盖项目回执/提案/任务，不代表IAM与准备材料原子回滚。

## Mock接入项目模型绑定基础（2026-10-12）

内部在已登记工作区创建的Mock接入项目，存储命名空间和项目记录都绑定模型；摘要返回modelId。人员与来源角色授权继续生效，并叠加模型检查；默认/其他模型项目不复制或回退读取。非默认项目basis摘要包含模型，默认旧basis兼容保留。工作前后模型登记复验，读取期间撤销不返回内容，写入后撤销可能提示projectMayHaveCommitted，不能解读为已回滚。

目前独立模型项目可以在内部执行准备基础，但handoff仍在入口明确拒绝，返回MODEL_ONBOARDING_BINDING_REQUIRED；没有创建提案/任务或读取交接样本。默认接入与交接流程不改。后续需用实际项目、资料修订、连接/对齐basis及交易内提案/任务创建完成受控交接，不能通过给旧记录添modelId来绕过。

该阶段没有新增多模型项目HTTP/SDK/UI入口，不表示真实企业接入或完整多模型平台验收。测试使用隔离合成IAM与Mock资料。

## 完整内部Mock建模验证与项目交接边界（2026-10-12）

已验证WMS OpenAPI的完整内部链路：明确主键/必填字段/类型，资料绑定后产生候选，真实Critic通过，人工修改标签，再签发确认并采纳；同模型快照、证据完整性及默认模型未受影响均核对。没有跳过Critic，也不代表任意不完整字典都可自动采纳；原简化原料候选继续被阻断。

异步请求型提案创建会在进入及保存后检查登记；撤销时拒绝返回，提案可能已保存，不能假称回滚。旧Mock接入项目尚未记录模型归属，不能直接准备/采纳到独立模型，返回MODEL_ONBOARDING_BINDING_REQUIRED；默认模型旧接入流程保持。后续需先实现项目显式模型绑定，再开放交接，不接受仅改proposal.modelId来绕过。

当前仍无独立模型任务全文/创建/确认/执行HTTP/UI；验证使用Mock模型运行时和合成资料，不证明真实方舟智能质量或企业授权完成。

## 任务每轮明确来源消费（2026-10-12）

内部consume要求systemCodes非空且全部属于当前模型绑定范围；即使绑定ERP/QMS，本轮只选ERP也只把ERP资料送入任务模型理解、候选发现与提案。资料不会作为上传materialRefs持久化继承，后续对话不能绕过当前资料指纹与权限检查；绑定整体发生变化需重新确认，不使用局部旧资料。

任务保存前/返回前复验绑定；执行前后核对systemMaterialBinding，确认后来源变动不再执行。写入后变化可能提示taskMayHaveCommitted或workspaceWriteMayHaveCommitted，不表示已写事件/草稿被原子撤回。候选Critic/映射仍可阻断签发确认，模型资料绑定不是采纳许可。

当前只有内部任务消费接入，无新模型任务创建/全文/确认/执行HTTP/UI。Mock已验证来源子集与旧绑定执行拒绝，完整候选人工修订和采纳成功链路仍需下一组验证。下方“尚未接入Agent任务”为此前阶段说明。

## 显式系统资料绑定基础（2026-10-12）

新增内部modelSystemMaterials组合，尚无HTTP/SDK/UI入口。inspect接收明确systemCodes，只返回编码、documentCount、revision与sourceFingerprint，不返回正文；bind还需confirmed=true、expectedRevision及预览取得的64位expectedSourceFingerprint，CAS成功才保存模型绑定元数据。当前主体必须有实际管理层、语义运营页面/保存权限，所选来源还需当前角色数据域可访问；绑定本身不增加授权。

内部load仅在同一已登记模型消费，每次重新核对IAM、资料指纹和绑定修订。资料变化、撤权、错误模型、未绑定、未知来源、空范围、无资料或提取告警均拒绝；不从默认文档池回退。最多16个系统/64份文本/2MiB，不调用上游。写入后状态变化可能已保存元数据，bindingMayHaveCommitted不表示可继续使用，消费仍必须复验。

此基础尚未接入Agent任务：后续须明确限定到每轮systemCodes，不可自动读取所有已绑定系统，也不代表完整系统资料授权、生产验收或模型任务闭环。

## 提案与回滚快照的模型标记（2026-10-12）

新提案、手工保存快照及采纳快照均记录modelId；公开提案/快照摘要显示此标记。主体或审核权限不能绕过模型匹配：即使记录被放入当前模型存储槽，只要标记属于其他模型或在非默认模型中缺失标记，依赖检查、修订、采纳、快照查询与回滚均拒绝。默认旧记录仅默认工作区兼容；不自动迁移或复制旧提案。

这里补的是记录级绑定，不是全部来源授权或等待后登记复验。系统材料显式模型授权、来源项目交接与完整任务入口继续审查，当前新模型HTTP任务仍只返回元数据；不能用已有提案摘要交给旧共享任务执行入口。回滚只影响当前草稿，不更改已发布定义或上游数据。

## 语义任务证据模型绑定（2026-10-12）

内部语义任务创建、事件追加、状态更新和证据读取已组合当前受信模型与登记复验；证据记录的modelId纳入完整性摘要。明确模型操作核对模型/租户和摘要，不通过traceId切换工作区，人员与角色读取限制仍生效。通用业务证据接口不能读取非默认模型；旧业务证据摘要及默认旧语义trace保留兼容。

已绑定证据保留按租户/模型分组，存储仍为全局唯一traceId，不宣称数据库物理隔离。仓储等待后登记撤销会拒绝返回/更新；事件可能已落库，不能冒称原子回滚。任务收尾此时标记evidenceUpdateBlocked，不写假完成证据。非默认模型的旧全局run索引绑定/恢复保持拒绝，独立run索引尚待开发。

当前模型任务HTTP仍仅元数据；来源发现与系统资料显式授权、全文/创建/确认/执行用户入口、运营端切换尚待审查补齐。证据模型绑定不授予企业业务数据权限，也不是完整多模型验收。下方“证据追踪尚未绑定”为历史阶段说明。

## 任务材料隔离边界（2026-10-12）

内部任务材料已按模型存储，材料摘要和记录均绑定当前模型。相同人员上传相同文档到不同模型会生成不同引用，加载必须同时满足人员、来源角色、模型及仍有效的登记；引用不能切换模型或引用旧默认工作区材料。默认工作区保留原摘要与安全旧编号兼容，新模型不允许缺少模型标记的旧材料回退。

新模型候选发现只使用明确提供的模型文档，不自动合并默认系统文档池。系统材料的显式模型授权绑定、证据追踪模型绑定以及任务全文/创建/确认/执行入口仍未完成；当前开放的任务接口仍仅返回元数据。内部写入可能因登记变化而失败，不表示已写局部材料被原子回滚；不提供客户端传材料引用绕过上传的接口。

## 限定模型发布接口（2026-10-12）

已开放POST `/api/semantic-operations/models/{modelId}/publish`，SDK为`publishModelWorkspace(modelId,payload)`。先读取指定模型draft，按返回的fingerprint校验并模拟，再明确确认发布：

```json
{ "confirmed": true, "expectedFingerprint": "返回的24位结构指纹" }
```

载荷只能包含这两个字段，不接受查询参数；GET、默认oa-governance工作区、客户端指定租户/角色/地址/凭据/版本均拒绝。会话主体需要管理层角色、语义运营页面和meta_model.publish权限，草稿保存权限不能替代发布权限。只使用服务端已启用的认证本机实例，未配置返回409/LOCAL_PUBLICATION_TARGET_REQUIRED，不会回退到共享实例。

成功仅返回modelId和publication状态/版本/指纹，projectionScope=definition_only、runtimeReadEnabled=false，不返回完整模型、凭据或地址。不启用智脑对新模型的业务读取，也不支持在此接口配置企业上游。

SDK校验模型与确认载荷后才发送，POST不自动重试。错误含publicationMayHaveCommitted=true时可能已发生远端写入，须检查原草稿、权限和部署；结果不确定的同指纹再次确认仅查原版本，不重新发布。已完成版本再次请求返回PUBLICATION_ALREADY_COMPLETED，可通过workspace摘要查询已登记版本。不能更换草稿绕过未完成对账。

实际HTTP会话验证两租户同名模型独立发布至临时Python实例，伪造租户头不能切换来源；重复发布不再次写入。缺少发布权限、无登录、非法参数与未配置目标分别拒绝；测试数据和IAM主体均为隔离合成夹具。下方“未开放HTTP/SDK”是历史阶段记录，运营端多模型选择和材料/证据整链仍待完成。

## 发布编排真实本机验证（2026-10-11）

执行`npm run test:semantic-instances`已通过32项真实临时进程测试。新增编排使用实际IAM服务、合成用户和临时Python实例，验证两租户各两个独立模型发布；真实认证网络探测后撤权或配置凭据变化不发送定义POST。真实远端提交后撤权、响应人为丢失时保持待对账，恢复权限后仅查询原模型/版本，不重复发送。

新模型完整定义回执也参与SQLite离线备份/恢复比较；内存实例重启返回未发布，不虚构持久化。测试不修改既有实例配置、企业IAM或上游数据，结束后关闭临时进程并清理临时配置。当前尚无新模型发布HTTP/SDK用户入口，也未启用业务读取；下一组补入口与契约。下方“真实本机链路尚待验证”是上一阶段记录，不代表企业生产验收完成。

## 本机发布编排状态（2026-10-11）

内部治理编排已接入实际IAM：当前主体需有管理层角色、语义运营页面及meta_model.publish权限，并明确确认当前24位结构指纹。部署配置必须是已启用、带认证的127.0.0.1或IPv6回环实例；凭据和目标来自服务端配置，不能由用户载荷选择。登记、草稿、执行权、IAM版本/权限及实例配置在等待后重新检查，外层旧IAM快照不能直接授权。

此编排不开放新的HTTP/SDK发布操作，也不启用新模型业务读取。七项隔离回归使用实际IAM与合成用户、替身部署器，尚待真实本机HTTP/Python链路验证。远端回执后撤权保留待对账；恢复授权后仅查询原版本，不自动重发。返回仅状态/版本/指纹，不含模型全文、密钥或地址。IAM与治理存储不是原子权限事务，不能把失败解释为远端副作用已撤回。下方“应用编排待完成”是上一阶段记录。

## 发布复验扩展状态（2026-10-11）

新模型用户发布入口尚未开放。内部发布服务已支持可选`expectedFingerprint`和可信服务端`beforeDispatch`函数：prepare为发布器前、dispatch为实例认证网络预检后正式发送前、commit为回执确认后本地登记前。应用编排需在这些等待窗口重新核验真实IAM、登记/草稿/版本、执行权及固定本机实例；不能把客户端传来的字段当函数或授权。

发送前被拒绝且确定未进入POST时记录not_attempted；回执后复验失败保留reconciliation_required，不启用本地业务读取。恢复只查询原模型、部署、版本和指纹，不自动重复发定义；远端可能已经保存，不能把本地拒绝解释成远端回滚。commit等待结束后重读发布锁，旧执行器不覆盖后继。

此扩展没有自动给全部旧内部调用增加IAM复验，也没有开放企业发布。5项内部隔离替身及真实本机HTTP桥接预检/零POST测试通过；不代表真实企业授权或新Python端发布验收。后续需要应用层本机限定编排、HTTP/SDK及闭环测试。

## 模型任务摘要查询（2026-10-11）

GET `/api/semantic-operations/models/quality-model/tasks?offset=0&limit=30&includeArchived=false`读取当前可见任务摘要，单个摘要使用同路径`/{taskId}`。SDK对应`modelTasks(modelId,filters)`和`modelTask(modelId,taskId)`。

要求当前管理层及语义运营页面权限，另外保留原任务的所有者、审核权限、审核指派和任务自身所需权限检查。管理层模型访问不等于所有任务访问：他人非审核任务、指派给他人的审核任务或缺少任务权限均不会出现在列表，详情404。当前模型下不存在的任务不能从默认模型或其他模型回退读取。

只返回泛化标题、状态、时间、所需权限、确认标记和可选提案编号/修订/状态；`contentScope=task_metadata_only`。不返回用户原始标题、对话、材料、提案全文、证据或执行结果。资料与证据整链尚未完成模型绑定，因此新模型路径不提供任务创建、确认或执行，不应将摘要交给旧共享任务操作接口。

分页最多100条、offset最多1000000；`includeArchived`只接受true/false，默认false。拒绝重复参数、额外选择参数和详情查询参数；结果分页不表示数据库游标或大规模扫描性能已验收。权限或登记在等待期间改变时拒绝返回；不能更改租户/角色头绕过。当前测试使用隔离合成任务记录，未调用收费模型或真实企业来源。

## 指定模型的校验与合成模拟（2026-10-11）

先GET该模型draft取得结构指纹，然后明确执行：

- POST `/api/semantic-operations/models/quality-model/validate`：管理层、页面及`meta_model.draft.validate`权限。
- POST `/api/semantic-operations/models/quality-model/simulate`：管理层、页面及`meta_model.simulate`权限。
- 两个POST均提交`confirmed=true`与实际GET得到的`expectedFingerprint`，不能携带额外选择参数。SDK对应`validateModelDraft(modelId,payload)`、`simulateModelDraft(modelId,payload)`。
- GET `/api/semantic-operations/models/quality-model/simulation`或SDK`modelSimulation(modelId)`：仅读取已保存模拟摘要，需要管理层及页面权限；没有模拟或再次保存草稿后simulation=null。

过期指纹409需重新核对；校验返回failed表示检查未通过，模拟遇到校验失败返回422，不创建成功记录。结果只含检查名称/状态、模型与结构指纹、数量和合成标记，不展示实例原文或完整回放。当前是内置本地结构/合成回放，不调用独立Python验证、上游或大模型，不代表正式发布、业务授权或真实场景验收。正式受控发布用户入口、模型任务接口和UI仍未开放。

写后权限变更或存储失效若提示`workspaceWriteMayHaveCommitted=true`，重新取得合法权限后只读核验，不自动重发或假设已经回滚。`sourceFingerprint`绑定当时草稿结构；模拟状态不授权读取企业数据。下述旧阶段“校验/模拟入口待开发”已由此限定入口补齐，不能通过旧共享路由请求头切模型。

## 指定模型的人工草稿读写（2026-10-11）

模型登记后GET `/api/semantic-operations/models/quality-model/draft`取得限定结构和`draft.fingerprint`；需要当前管理层角色及语义运营页面权限。POST同一路径需额外保存权限，提交：

```json
{
  "confirmed": true,
  "expectedFingerprint": "上次实际读取的24位小写十六进制结构指纹",
  "input": { "policies": ["合成规则：异常批次需人工复核"] }
}
```

示例指纹是说明文字，使用时必须换成GET实际返回值。`input`只接受场景、对象、关系、状态机/事件以及约定的治理资产；省略保留，规则数组为空表示清空，不是“忽略”。不接受tenantId、modelId、worldModel或任意额外顶层字段。结构冲突409需重新读取核对，不盲目覆盖；合法结构变更和本模型快照原子保存。SDK：`modelDraft(modelId)`、`saveModelDraft(modelId,payload)`，不缓存全局模型选择。

此入口读取的是模型配置，不读取业务事实；完整材料世界模型、历史审计和快照差异不返回。保存只表示草稿结构已保存，不表示规则验证、审核、模拟、发布或智脑读取已启用。新模型初始为结构模板，不复制其他工作区用户修改。现有校验/模拟/任务旧接口不能靠请求头切到新模型，相关新入口仍待开发。

保存后若返回`workspaceWriteMayHaveCommitted=true`，重新获得合法权限后GET指定模型核验，不能自动重发或假设已回滚。权限库与模型库不是跨库原子事务，保存后撤权可能已经有本地副作用。回归纳入多租户111项，仅使用合成数据，不代表生产原子授权验收。

## 当前模型登记接口（2026-10-11）

使用现有登录会话，租户从服务端身份取得，不传tenantId或模型选择头。当前要求管理层角色及语义运营页面权限，登记另需`meta_model.draft.save`。仅登记元数据，不会复制旧模型、绑定实例、发布或授予公司数据读取。

1. GET `/api/semantic-operations/models`取得当前`revision`与模型列表。
2. POST同一路径提交`{ "id": "quality-model", "label": "质量模型", "expectedRevision": 0 }`，修订号使用上一步实际值；可选description，不允许额外字段。返回201及新修订，最多31个新模型加默认工作区。冲突先重新读取核对，不盲目重复提交。
3. GET `/api/semantic-operations/models/quality-model/workspace`查看模型摘要。仅数量、指纹和模拟/发布状态，`selectionScope=request_only`，不改变后续旧路由或启用业务读取；不接受查询参数。

SDK对应`modelWorkspaces()`、`registerModelWorkspace(payload)`和`inspectModelWorkspace(modelId)`。新模型返回`runtimeBinding=not_bound`，摘要列明未开放操作；目前没有运营端完整模型切换/编辑界面。

接口每次等待后重新核对权限。409若含`registrationMayHaveCommitted=true`，表示登记可能已经保存：重新取得合法权限后GET列表核验，不能自动重发，也不能假设已回滚。登录超时/权限不足仍需原身份管理流程解决，不能靠更改角色头绕过。回归纳入`npm run test:multitenant`，仅本机合成数据。

更新日期：2026-09-17。适用范围：本机 Node API 到独立 Python Semantica 进程的受控接入及单实例持久化。

## 已实现与未实现

门户侧现已提供[开通申请及实例预检子流程](PORTAL_RUNTIME_PROVISIONING.md)，可核验受保护的持久化实例，但不会自动启动Python进程或授予业务权限。

一个租户绑定一个独立进程、端口、部署标识和服务密钥。API 从已认证租户上下文选择实例；客户端不能传入目标地址或用请求体切换租户。实例在读写前校验服务身份，API 在发送模型前核对实例回执，收到结果后再次核对。

本次已用两个真实 Semantica 进程验证独立发布、图数据隔离、重置隔离、错误绑定拒绝、停用及密钥轮换后旧密钥拒绝。没有修改当前用户服务的运行配置，也没有开通实际企业租户。

2026-09-17 补充：已提供按租户/部署绑定的 SQLite 原子快照。开启后，模型及发布回执、图、来源事实、运行记录和去重索引在重启后恢复；写盘成功之后才返回操作成功。内存模式仍用于本地兼容测试，不冒称持久化。

以下能力仍未完成：

- 定时/在线备份、异地加密备份、保留与清理策略、故障迁移、数据库升级迁移。已实现停机校验、手动备份和恢复到新文件，并完成合成恢复演练；不是集群容灾能力。
- 门户开通到执行面 IAM、成员映射、权益和在途任务撤权。`runtimeConnected` 仍为 false。
- 企业真实源数据的租户来源证明及接入。平台共享 Demo 演练库不能自动导入其他租户。
- 容器/操作系统隔离、生产存储隔离、远程 TLS/mTLS 接入与多实例压力验收。进程隔离不是抵御本机管理员的安全边界。

## 配置归属

| 使用方 | 配置 | 内容与边界 |
| --- | --- | --- |
| Node API | `SEMANTIC_INSTANCES_FILE` | 绝对路径，平台部署人员管理；保存租户到端点及密钥的绑定 |
| 每个 Python 实例 | `SEMANTIC_INSTANCE_CONFIG_FILE` | 各自独立的绝对路径；只含本实例的租户、部署标识和密钥 |
| 每个 Python 实例 | `SEMANTIC_CONTEXT_PORT` | 本机独立端口，服务只监听 127.0.0.1 |
| 每个 Python 实例 | `SEMANTIC_INSTANCE_DB` | 租户独立SQLite文件绝对路径；父目录须预先存在，不能复用其他租户/部署的数据文件 |
| 每个 Python 实例 | `SEMANTIC_REQUIRE_DURABLE_STORAGE=true` | 缺数据库配置时拒绝启动；`NODE_ENV=production` 同样强制要求数据库 |

文件应保存在仓库外，例如 `D:\wsl\private\yuanyu-zhinao\semantic`，通过文件系统权限仅允许对应服务账号读取。密钥不要提交 Git、粘贴进聊天或放进前端环境变量。每个密钥使用加密随机生成器生成至少32字节，再编码为 base64url；长度43～128字符，不同实例不得复用。

Node 注册表格式如下。占位密钥必须替换，不可直接启动：

```json
{
  "version": 1,
  "instances": [
    {
      "tenantId": "company-a",
      "deploymentId": "semantic-company-a-01",
      "enabled": true,
      "endpoint": "http://127.0.0.1:3031",
      "token": "<独立随机密钥A>"
    },
    {
      "tenantId": "company-b",
      "deploymentId": "semantic-company-b-01",
      "enabled": true,
      "endpoint": "http://127.0.0.1:3032",
      "token": "<独立随机密钥B>"
    }
  ]
}
```

`tenantId` 必须与服务端认证身份的租户标识一致，不是任意企业名称。注册表不会创建身份、成员或权限。租户/部署标识目前只接受字母数字开头及字母数字、下划线、点、冒号、短横线，最长120字符。

实例 A 的配置格式如下，密钥与注册表中 A 的值一致；实例 B 使用自己的值：

```json
{
  "version": 1,
  "tenantId": "company-a",
  "deploymentId": "semantic-company-a-01",
  "token": "<独立随机密钥A>"
}
```

## 启动顺序

先以各自服务环境启动独立实例。下面为 PowerShell 中实例 A 的示例；B 使用3032端口和独立配置文件。项目目录下已有安装 Semantica 的虚拟环境时可使用：

```powershell
$env:SEMANTIC_CONTEXT_PORT = '3031'
$env:SEMANTIC_INSTANCE_CONFIG_FILE = 'D:\wsl\private\yuanyu-zhinao\semantic\company-a.json'
$env:SEMANTIC_REQUIRE_INSTANCE_AUTH = 'true'
$env:SEMANTIC_INSTANCE_DB = 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a.db'
$env:SEMANTIC_REQUIRE_DURABLE_STORAGE = 'true'
.\.venv-semantica\Scripts\python.exe services/semantic-context/app.py
```

启动前先创建并限制 `state` 目录的文件权限，B使用自己的数据库路径；不要使用项目源文件或其他应用数据库。然后在 Node API 的服务环境设置以下变量，按现有 API 启动流程重新加载后端：

```powershell
$env:SEMANTIC_INSTANCES_FILE = 'D:\wsl\private\yuanyu-zhinao\semantic\instances.json'
$env:SEMANTICA_DEMO_BRIDGE_ENABLED = 'true'
```

不要把配置文件或 Python 启动命令交给最终业务用户。当前没有从门户自动启动进程的功能。

## 拒绝与回执规则

- 注册表一旦配置即为唯一依据：未知、停用、文件缺失或格式错误都拒绝，不回退到 Demo。即使是 Demo 租户，也需要显式登记；生产 Node 环境始终要求显式绑定。
- 租户、部署标识、规范化后的端点及密钥不能重复。其他租户不能占用隐式 Demo 的地址。只允许无路径、无凭据、无查询参数的本机 HTTP 根地址；不跟随重定向。
- Python 在配置读取失败时拒绝启动；`NODE_ENV=production` 或 `SEMANTIC_REQUIRE_INSTANCE_AUTH=true` 时缺配置也拒绝启动。未配置时保留原本地 Demo 兼容模式，不能把该模式当生产认证。
- Python 对所有已有 GET/POST 业务接口和健康检查校验 Bearer 密钥、租户与部署标识；重复身份头、错租户、错部署或错密钥均403，拒绝响应不含实例数据。
- API 先访问受保护的 `/instance` 核对三个响应头，再发送模型；操作响应再次核对 `X-Semantic-Tenant`、`X-Semantic-Deployment` 和 `X-Semantic-Protocol: 1`。验证后的发布结果附带安全的实例标识，不返回密钥。
- 预检失败且未发送发布 POST 时，发布状态是“未尝试”，配置修复后可以重试。POST 已发出但回执丢失或不匹配时保持不确定状态，只能对账，不自动重发。
- 共享 Mock 场景库没有完整租户来源证明，因此非 Demo 的自动图同步仍返回 `tenant_fixture_unavailable`。进程测试直接向各自临时实例写合成事实，不代表企业连接器已经接入。

Node 每次操作重新读取注册表，但操作开始后使用其绑定快照。停用影响后续请求，不取消已经派发的在途请求。Python 配置只在启动时读取；轮换密钥需要重启实例并同步更新注册表，旧密钥随后失效。开启持久化后，在租户/部署标识和数据库路径不变的情况下轮换密钥会恢复原状态；密钥不写入数据库。未开启持久化的本地内存模式仍会在重启后丢失状态。

## 同实例的独立模型定义协议（本机开发子项）

2026-10-11新增服务内部协议；已登记模型可在内部受控工作区走平台发布和对账，运营端尚无模型选择入口。不要用手工HTTP部署代替平台审核和发布。

- 路径为`/models/{modelId}/instance`、`/definition`、`/definition/validate`与`/definition/publish`；前两项GET，后两项POST。模型编码使用2–64字符小写字母、数字、连字符，以字母开头；`oa-governance`保留给旧默认工作区，不允许通过新路径访问。
- 必须通过上述租户/部署/凭据认证，无凭据Demo不能使用。一个实例最多31个新定义槽位；租户通过独立实例隔离，模型通过命名空间隔离。未知模型GET返回`not_published`，不会创建槽位或回退默认模型。该凭据属于服务端，不能交给浏览器或Agent文本。
- 发布请求仅含`definition`和`expectedFingerprint`。首次创建传`null`，修改传上次回执中的完整定义指纹；旧指纹或超预算返回409，不覆盖。相同完整定义重试保留原时间和回执。模型命名空间与`definition.id`是不同层级，不能只按后者判断部署归属。
- Node内部传输必须显式绑定`modelId`，先检查该模型的`/instance`，再发定义；响应除租户/部署协议外还必须包含`X-Semantic-Model`与`X-Semantic-Model-Protocol: 1`。预检不匹配不发送模型，操作后不匹配仍是不确定结果，不能宣称发布成功。
- 新模型定义回执声明`projectionScope=definition_only`、`runtimeReadEnabled=false`：只保留结构定义，不读取默认事实图，不启用智脑业务访问。独立合成图协议见下节；平台事实授权准入、后台巡检和HTTP/UI还需后续完成，SL-06b保持未关闭。
- 新模型定义纳入同一实例SQLite原子快照，图重置保留所有定义；旧版没有`models`字段的快照仍可恢复。备份/恢复会校验并保留全部槽位。默认定义相同来源指纹但内容变化时返回409，避免重复部署误返回旧定义。

内部受控发布先通过注册工作区准入，读取目标定义并保存租户/模型/部署绑定。首次槽位必须为空；后续远端版本及来源指纹须与本地已发布基线一致，不一致返回`PUBLICATION_DEPLOYMENT_DRIFT`，未写入远端。直接调用发布桥接而缺少匹配预检回执时也拒绝发送。实际定义POST携带CAS指纹，服务拒绝并发覆盖。

若POST已经提交但响应丢失，锁进入对账状态；后续只查原部署、同一模型、同一发布版本和来源指纹，不重新发送。改了部署配置、回执属于另一模型或查到其他版本不能解除锁。不要通过删锁、强写槽位或复制回执绕过核对；受控漂移处置及跨部署迁移还需后续开发。

预检时修改草稿不会发送旧定义；发布期间修改草稿不会误登记新版本。登记失效或旧执行器失去发布锁也不能完成登记。共享图重置、场景导入和候选发现仍不支持非默认工作区；默认路径兼容保留。

验证：Python43项、传输14项、多租户89项、独立发布10项、本体200项、真实Semantica进程20项及全仓回归通过，均为临时实例及合成数据；不代表企业隔离、生产容量或运行语义质量验收。

## 独立合成事实图协议

### 显式关系候选预览与内部受控物化

Python规范定义现保留对象`fieldDefinitions`及关系`keyMapping`。字段定义必须引用已声明字段，主键映射须为对象；保留不是执行许可。已有部署缺少这些信息时，必须走受控版本更新，不能自动补定义或重新解释历史图。

内部`ModelGraphs.preview_relationships(model_id, run_id, definition, tenant_id)`核对租户及当前冻结模型指纹，再预览本run的显式关系。仅支持声明式`n:1`/`1:1`、两端各单一来源、唯一外键字段引用目标主键；事实须带组织和来源版本，匹配组织相同、UTC时点相同并保留数值/字符串类型差异。编号相同不能代替外键声明，也不生成反向边或合并实体。

未知或多重绑定、重复目标、1:1冲突、keyMapping转换、关系有效期、推断关系和多来源对象明确阻断整批；不静默执行、不返回部分成功。预览最多100事实、10000处理预算、1000候选边；只返回关系结构和匹配/未匹配数，不返回事实值。结果标记`synthetic_relationship_preview`、`materialized=false`、`runtimeReadEnabled=false`。

真实Semantica对象测试确认预览不修改节点/边及快照，错误租户/模型/版本拒绝、定义引用跨恢复保留。内部`materialize_namespaced_relationships`仅接受`runId`、`expectedFingerprint`、`expectedRunProof`和明确`confirmed=true`；复验当前冻结定义及实际存储事实证明，重新生成候选，不接受调用方提供的关系边。重复声明、歧义及预算失败阻断整批。成功边标记声明外键溯源、模型/租户/版本/run和投影指纹，不建立实体等价或真实业务授权。

相同请求重复执行幂等；已物化run冻结，不能追加事实，完全一致事实重放不改证明；其他run独立接收，不自动生成关系。持久化失败回退内存和关系边并停止写入。重启根据事实和声明重新计算证明及图，拒绝伪造证明、任意边和不存在的run；含物化关系快照为v3，兼容读取旧v1/v2，降级版本拒绝，旧服务也不会静默覆盖v3。

认证实例现提供以下开发协议，凭据仅由服务端持有；未提供运营端或智脑操作入口。

| 方法及路径 | 用途 |
| --- | --- |
| `POST /models/{modelId}/graph/relationships/materialize` | 严格四字段确认请求，重新核对定义、事实证明并持久化关系 |
| `GET /models/{modelId}/graph/relationships/runs/{runId}` | 只读重算并核验已物化证明；返回数量和绑定，不返回记录/边原文 |

协议要求实例租户、部署和认证令牌，以及模型回执与`X-Semantic-Relationship-Protocol: 1`。Node传输必须明确`projectionScope=synthetic_relationships`，先探测实例及关系协议，再执行严格路径/方法；不支持协议时在发送前拒绝，不回退旧图入口。响应范围、模型、`relationshipProtocol=1`、`runtimeReadEnabled=false`均须一致。关系范围不能重置图、发布定义或查询任意上下文。

只读状态为`not_materialized`或`materialized`，run不存在返回404，当前定义变化/证明不匹配返回409；不会将未知或失败状态自动改为完成。网络协议验证覆盖两租户各两个模型、同run幂等、跨身份拒绝、SQLite重启及离线备份恢复。平台仍须补Node新鲜IAM、发布/部署复验和独立持久化提交/未知回执对账；认证实例调用本身不等于业务授权。智脑独立模型业务读取仍禁用。

### 关系物化前置复验（Node内部、只读）

`prepareSyntheticRelationships`在服务端已准入工作区使用原事实输入、run/scenario及已验证身份；不创建或选择工作区。仅接受有认证配置的字面本机HTTP实例，固定配置及凭据代次。准备必须核对原提交人、已完成事实发送台账、原输入摘要、发布版本、来源指纹、实例图指纹及实例从存储事实重算的完整run证明；发送结果尚不确定时先完成原事实只读对账，不能跳过。

等待实例读取后重新加载IAM、准入/发布状态及发送记录，最后再次复验当前权限和配置；权限撤销、权限版本变化、发送记录或配置漂移均拒绝。成功只返回`relationship_preparation_passed`、模型/run/版本、证明和计数，`relationshipWriteAttempted=false`、`writeAuthorizationIssued=false`，不返回事实值、凭据或实例地址。不生成关系，也不宣称关系声明可物化；声明支持性仍由物化引擎检查。

准备结果不可作为后续请求票据。Node实际提交及独立关系状态台账、未知关系结果只读对账尚未开放；提交时仍须重新执行门禁，不扩展真实企业权限或智脑独立模型读取。

### 内部Node关系提交与只读对账

服务端编排`materializeSyntheticRelationships`要求明确`confirmed=true`，重新执行前置复验，固定本机实例；关系台账按当前租户/模型保存原提交人、输入摘要、部署/版本/事实证明及关系回执，不保存事实载荷或凭据。每模型最多100批次/256KiB。持久化dispatching与60秒租约后，再次复验当前上下文才进入POST；相同完成请求直接返回`already_completed`，并发不重复提交。

不确定回执、权限或版本在提交后变化，保留`reconciliation_required`或dispatching，阻断同模型新关系提交，不自动重发。提交前明确未发送的失败记为`not_attempted`，也不自动清理后重试。实例与Node没有分布式事务，本地失败不能宣称关系边已撤销。

`reconcileSyntheticRelationships`只GET原run，复验原提交人、当前权限及绑定，核对实例重算的完整事实和投影证明、数量、关系协议及禁用业务读取回执。保存过投影证明时须完全一致；首次回复完全丢失时依据认证实例重算的关系证明核验，不宣称Node独立推导了关系边。未物化/未知run/错误证明或版本不恢复完成；活动租约未到期拒绝，过期也只读核验、不重新POST。CAS保护旧执行器不能覆盖对账终态。

Node执行/对账已通过隔离替身、SQLite多进程台账恢复及真实临时Python端到端验证。两租户各两模型分别使用QMS检验事件与ERP原料，经过登记、通用草稿/模拟、受控发布及合成事实发送，再明确确认生成关系；相同run保持独立。实际物化成功后模拟回复丢失，重复操作不重发，只读对账核验实例重算证明，再次执行不POST；SQLite离线备份/恢复后的证明一致，内存重启不会凭Node台账虚构实例关系。

关系提交通过服务端`beforeDispatch`钩子，在实例预检网络等待后、进入正式POST前再次执行新鲜权限/模型/事实复验及租约检查；钩子不是请求体参数或客户端授权票据。撤权用例确认正式发送未进入、关系状态仍未物化且图统计不变。已知传输层`requestAttempted=false`记为未发送；进入正式传输后的失败仍保持待对账，不自动重试。不宣称跨网络、IAM、Node与Python有分布式原子权限事务。

没有用户HTTP/UI入口或智脑独立模型业务读取，不将上述内部方法作为真实企业写入授权。

### 本机受控发送（内部合成验证）

`services/semantic-context/synthetic-fact-transfer.js`提供内部`transferSyntheticFacts`，必须明确确认，指定受限run/scenario编号并提交原准入结构；模型仍由服务器工作区决定。只接受配置注册、有身份保护的本机HTTP实例，不接受公网企业目标。不通过客户端指定连接、凭据或依赖函数；当前没有HTTP/UI入口。

发送前执行完整准备，固定目标及凭据代次；写入模型隔离的`semantic_synthetic_transfers`记录后再次复验再发POST，发送后核对实例身份、模型/图版本与run回执并再次复验权限/发布。来源版本与组织保留为Python事实`sourceVersion`/`organizationId`及图记录元数据，旧隔离图缺少两项仍兼容，但只带其中一项拒绝。Python本身不替代平台IAM授权，须部署包含此协议增量的服务。

Node发送记录只保留摘要绑定及溯源，不保存事实载荷或凭据；每模型最多100次、2MiB，达到上限拒绝而非自动淘汰。相同run与输入完成后不重复POST，不同输入冲突；并发只允许一个发送者。发送丢失回执、回执错模型或发送后权限/版本变化，保持`reconciliation_required`，不能解释为已撤销外部写入。`pending`/`dispatching`也阻止新发送，进程崩溃不会导致自动重发。

内部只读对账现由`reconcileSyntheticTransfer`提供：原提交人提交原批次，重新准入并查询原模型run。Python从实际保存事实、run溯源、版本和模型绑定重算完整`proofFingerprint`，不返回事实原文；Node核对存储摘要与证明后，再复验IAM/发布/部署并通过记录CAS恢复完成。数值采用IEEE754字节的类型化规范摘要，避免两种运行时的小数指数格式误差；Unicode按码点序编码，非法孤立代理字符拒绝。它不是仅核对记录条数。

活动发送租约为60秒，未到期不能对账；过期pending/dispatching只允许正向证明恢复，不会接管重发。找不到run、错误证明、版本变化、旧无证明记录或无到期信息的旧活动记录继续阻断，不自动解除；不开放人工清除入口。发送前再次检查租约，旧执行器不能覆盖对账后的终态。

Node SQLite多次独立进程验证两模型同run记录恢复、未知结果阻断、只读对账后不重复发送。真实Python进程已验证提交成功后模拟回复丢失、只读对账以及SQLite图重启/备份恢复；Node记录和实例不是分布式事务，也没有实际PostgreSQL服务或生产恢复验收。业务关系物化、智脑独立模型读取和平台界面仍未开放。

### 合成事实准入预检（内部、本机）

服务器先进入现有IAM上下文和登记工作区，再调用`previewSyntheticFactAdmission({ identityScope, body })`。`body`仅含`modelId/version/fingerprint/records`，版本与指纹是Node已发布定义绑定，不是Python图定义指纹。每条记录包含`id/tenantId/organizationId/version/occurredAt/classification/sourceSystem/objectType/simulated/payload`；`version`是来源记录版本，`simulated`必须为true，时间含时区。对象、来源与载荷字段来自已发布定义，主键不可缺失；公开/内部级记录仍须在当前组织权限内。

最多100条、总计256KiB，不接受重复编号、嵌套对象/数组、未知字段或非有限数字。通过返回`preview_passed`及计数，不返回事实原文，也不访问实例、保存事实或签发凭证。预检失败返回稳定错误码并标记未请求。不应把用户上传材料包装成“真实来源已验证”；合成标记和来源版本本身不是企业真实性证明。

基础预检在Memory/SQLite验证通过。内部应用编排`services/semantic-context/synthetic-fact-preparation.js`新增`prepareSyntheticFactTransfer`：调用者先进入服务器准入工作区，函数不依据请求体切换租户/模型；重新加载IAM后预检，要求本槽位发布锁已完成且绑定当前发布版本与目标部署，再只读检查实例定义回执。远端返回后再次加载IAM、预检发布/登记与锁，最后一次独立IAM加载覆盖语义仓库等待窗口。异步仓库替身已验证旧请求快照不被复用；这不是实际PostgreSQL部署验收或跨仓库事务。

准备通过返回`preparation_passed`、计数、`sourceFingerprint`（Node本体指纹）与`graphFingerprint`（Python规范化定义指纹），不返回事实原文、连接信息或凭证。`readRequestAttempted`表示进入只读检查阶段，不保证网络请求已发出；`factWriteAttempted=false`、`writeAuthorizationIssued=false`。漂移、权限变化、模型停用和发布状态不确定均拒绝；不自动覆盖或重发。准备结果不可作为后续写入授权，实际发送必须重新执行门禁并绑定目标，不能拿本体指纹代替图指纹。受控发送/关系投影、模型选择HTTP/UI及智脑独立模型读取仍未开放。

### Worker显式启动绑定（2026-10-11最新）

服务器管理员可在仓库外保存以下JSON，并把其绝对路径设置为`SEMANTIC_INSPECTION_BINDING_FILE`。这是配置示例，不会创建人员、注册模型或提升权限；模型及当前IAM人员必须已存在。示例全部为合成标识，请勿直接用于生产。

```json
{"version":1,"tenantId":"demo-enterprise","subjectId":"usr-001","modelIds":["finance","production"],"maxRuns":10}
```

```powershell
$env:SEMANTIC_INSPECTION_BINDING_FILE = 'D:\wsl\private\yuanyu-zhinao\inspection.binding.json'
npm run run:semantic-inspection-worker
# 核验单次结果后，常驻启动：node services/semantic-inspection-worker/app.js
```

文件最多16KiB，仅接受上述字段；预算1–100、模型清单1–32且不重复。Worker每轮重读文件，并按本租户IAM核对人员有效、执行层角色及语义页权限。执行前后还核对权限版本，撤权结果不接受。配置文件不含密钥，但应由服务器管理员控制修改权限，不作为用户可上传的附件或HTTP请求体；现有代码不负责配置文件ACL部署。

生产无绑定返回`SEMANTIC_INSPECTION_BINDING_REQUIRED`；文件无效、人员无权限或模型未登记分别明确失败。显式绑定失败不回退Demo，日志不打印配置原文或身份。常驻周期失败停止计时器并退出失败状态，交给运维排查，不无限重试。非生产未指定绑定仍保留旧默认行为。SQLite恢复计划/上次结果/下次运行时间；未到期不重复，过期执行租约按原规则恢复。

本机隔离进程验证已通过，未改用户现有服务配置。只启用独立模型结构完整性和映射覆盖，不访问企业源、不发布模型；生产启用需另外完成身份、运行准入、持久化与运维验收。下文早期“Worker暂未接入配置”属于历史阶段，以本节为准。

显式巡检发现（2026-10-11）：内部调用`runRegisteredSemanticInspectionCycle({ role, identityScope, modelIds, executeInspection, maxRuns })`前，租户身份和模型清单必须由服务器确定，不能透传请求体。当前只接收执行层已登记模型，清单最多32项，不重复；全清单预检失败时不领取任何计划。每模型轮流领取一项，共用最多100项总预算，不额外扫描默认模型或其他租户。独立模型计划仅接受`schema_integrity`和`mapping_coverage`，只读执行器读取本工作区草稿，不做来源全量扫描或部署请求。真实业务数据、自动修复和模型发布不在执行范围。

现有`semantic-inspection-worker`进程暂未接入可信租户/模型启动清单，默认运行行为保持原样；上述内部入口可用于本机合成联调，不代表生产定时服务已经启用。后续配置化启动和重启恢复验证完成前，不要靠改数据库、拼接客户端模型编号或创建计划假定后台正在巡检。

Agent任务恢复边界（2026-10-11）：新聊天/模拟接入任务及公开出参带服务端模型编号；任务入口、续聊、审核指派、修订、归档、导出回执、确认和执行会核对工作区。旧无编号任务只默认兼容，客户端传编号不能选模型。内部已准入工作区可恢复本槽位受控任务，执行前/后复验登记；私有执行租约到期或已被后继取代时，旧结果不能归档。登记失效只拒绝结果接受，不撤回已完成的校验，也不构成企业写入回滚。平台模型选择、定时任务发现以及材料/证据整链绑定仍未开放。

后台引用边界（2026-10-11）：新通知和打开动作包含服务端模型编号；模型编号与当前工作区不一致时不可见、不可标记已读，不会通过动作切换模型。新默认巡检计划同样记录编号，领取、控制和完成均核对归属。旧记录缺少编号只在默认工作区兼容。内部恢复的独立槽位巡检保留已准入工作区、恢复原租户身份，并在执行前后复验登记；登记失效保存失败而非采纳结果。非默认模型创建计划和自动发现仍关闭，不要手工复制或修改巡检存储来启用它。

这仍是本机开发接口，凭据只由服务端持有，运营端和智脑尚无业务读取入口。每个模型的图独立，不使用默认Demo图；当前仅建立来源溯源，不自动构造跨系统业务关系。

| 路径（均位于`/models/{modelId}/`） | 方法 | 用途 |
| --- | --- | --- |
| `graph` | GET | 当前模型图计数与定义绑定，不返回事实原文 |
| `graph/runs/{runId}` | GET | 当前模型指定合成run的记录数与系统覆盖 |
| `graph/ingest` | POST | 接收版本绑定的合成事实，不授予业务权限 |
| `graph/reset` | POST | 当前定义指纹确认后，仅重置这个模型的图 |

接收请求包含`runId`、`scenarioId`、`expectedSystems`、`expectedFingerprint`、`facts`及可选`businessKey`。每条事实除原受控溯源字段外必须包含匹配的`tenantId`、`modelId`、`modelVersion`和`modelFingerprint`，以及`simulated=true`。payload只能包含该对象已声明的字段，要求主键；目前仅支持有界标量值，不接受嵌套对象/数组或自行指定实体/边。来源必须在该对象的`sourceSystems`内，时间必须带时区。不将这些声明当作真实企业来源授权。

每次1–100条；每模型最多2000条、200个run及2MiB事实/运行索引预算。重复相同事实不新增，内容冲突、作用域不符、超预算均拒绝整批。相同编号在不同模型不互串；同模型不同系统也保持来源实体分离，不凭编号相同认定等价。

Node内部传输需显式`projectionScope: 'synthetic_graph'`，检查`X-Semantic-Graph-Protocol: 1`以及租户/模型/部署回执；图响应标记`runtimeReadEnabled=false`。旧实例不支持图协议时，在发送事实前拒绝，不回退默认路径。

定义更新后旧图标记过期，读/追加返回409；重置请求仅含当前定义的`expectedFingerprint`。不会自动迁移或删除旧图，也不会影响其他模型或默认图。定向重置是受控写入，不应交给无权限人员。平台事实准入及授权复验仍待接入，所以不能用此接口绕过企业数据权限。

带独立图的完整快照使用版本2；新服务兼容版本1，旧服务将拒绝版本2启动。恢复按冻结定义和事实重建节点/边后核对保存图，任何归属不一致或额外伪造边均拒绝。离线工具同时核对数据库归属与图内租户，不仅检查校验和。上线/降级前应保存可核验备份，不把降级到旧服务作为恢复办法。

最新回归：Python55项、传输16项、多租户91项、真实Semantica进程22项及全仓回归通过。未对现有业务实例或真实企业数据操作，不代表生产容量与完整世界模型已验收。

## 持久化及故障处理

- 每次成功发布、事实接收或图重置，在实例锁内保存完整快照；SQLite事务提交成功后才返回成功，使用 `synchronous=FULL`。读请求不会看到写入尚未提交的中间状态。
- 启动时校验数据库归属、快照版本、校验和及结构，恢复 Semantica 图和来源索引后才开始监听。原有文件损坏、归属不同、快照缺失或不支持的版本均拒绝启动，不创建空图掩盖问题。
- 一个数据库只能由一个本服务进程打开；跨进程文件锁阻止第二实例使用同一文件。锁随进程结束释放，不需要手工删除 `.lock` 文件。这不是防止有磁盘权限的外部程序修改数据库的机制。
- 快照上限32MiB，每次完整重写。适用于当前合成验证规模，尚未完成大图、长时间运行和生产负载验收。校验和用于检测意外损坏，不是对抗管理员篡改的密码学签名。
- 写盘失败、容量超限或提交结果不确定时，内存尝试回滚并将实例标记为失败，后续读写返回503。先排查磁盘/权限，再重启从最后一次已提交快照恢复；不能手工把状态改为成功。若恢复仍失败，应保留原文件排查，不删除重建。
- 图重置清空图、事实和运行记录，保留已发布模型；此结果也持久化。事实ID、场景ID与已接收内容冲突时返回409，不覆盖既有来源。
- `/instance` 返回 `storage=sqlite-snapshot`、`durable=true` 和快照修订号；内存模式为 `process-memory`、`durable=false`。这只表示本机持久化已启用，不是备份、高可用或生产安全认证。

现有运行中的内存实例不会被自动迁移。首次开启数据库从新实例初始状态开始；如需保留原内存数据，应先另行设计并验证受控导出/导入，不能直接重启并假定数据已迁移。已有数据库的租户/部署标识不可随意改动；自动重绑定和跨部署迁移尚未实现。

## 复现验证

### 停机备份与恢复

运维工具为 `services/semantic-context/manage_instance_store.py`，没有开放到业务端或模型工具箱。它只接受已有实例配置和绝对路径；数据库必须属于该租户及部署。源库按只读方式打开，若实例仍在使用源库则拒绝操作，不强行解锁或终止进程。

先按维护流程停止目标租户实例，保留原库。为备份目录配置与业务数据同等级的访问控制，再执行以下示例；目录应事先存在，目标文件必须是新文件：

```powershell
$semanticPython = '.\.venv-semantica\Scripts\python.exe'
$instanceConfig = 'D:\wsl\private\yuanyu-zhinao\semantic\company-a.json'
& $semanticPython services/semantic-context/manage_instance_store.py verify --config $instanceConfig --source 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a.db'
& $semanticPython services/semantic-context/manage_instance_store.py backup --config $instanceConfig --source 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a.db' --target 'D:\wsl\private\yuanyu-zhinao\semantic\backups\company-a-20260917.db'
& $semanticPython services/semantic-context/manage_instance_store.py restore --config $instanceConfig --source 'D:\wsl\private\yuanyu-zhinao\semantic\backups\company-a-20260917.db' --target 'D:\wsl\private\yuanyu-zhinao\semantic\state\company-a-restored-20260917.db'
```

备份和恢复均执行源校验、SQLite复制、目标再次校验，保留租户、部署、快照修订号及数据，不写入服务密钥。只有校验通过后才发布新目标文件；使用同目录临时文件和不覆盖目标的原子硬链接发布，不支持该机制的文件系统会拒绝，不降级为覆盖式复制。已有目标、源目标同名及目标在操作期间被其他程序创建时均不覆盖。

成功输出仅包含操作、状态、租户、部署和修订号；失败返回非零退出码。发生不确定失败时，目标文件可能已创建，应先用 `verify` 校验并核对记录，不能靠覆盖重跑消除不确定性。工具不删除源库、不切换环境变量、不重启业务服务，也不解除授权限制。

恢复后的库应先在维护环境用原租户/部署身份启动，检查模型版本、指纹、来源记录和图；同时核对Node侧已发布模型是否与备份一致。恢复旧语义库不会同步回滚应用侧草稿、会话、成员或账单，不能因为健康检查200就直接恢复生产流量。正式切换由运维审核后修改目标实例的 `SEMANTIC_INSTANCE_DB`，原库保留用于排查。

备份文件包含该实例的数据，当前未加密，也没有自动保留期限或异地副本。同磁盘备份不能抵御整盘损坏；合成演练不代表真实断电恢复或生产RPO/RTO已经验收。未对用户现有数据库执行备份或恢复。

### 自动化回归

```powershell
npm run test:multitenant
npm run test:semantic-instances
.\.venv-semantica\Scripts\python.exe -m unittest discover -s services/semantic-context -p 'test_*.py'
```

第二条命令分别以内存和SQLite模式启动两租户临时真实 Python/Semantica 进程，用动态端口和随机测试密钥，经 Node 适配器调用真实 HTTP；每种模式都终止并重启两个实例，验证旧密钥拒绝、模型/图恢复差异和重置不复活。测试结束关闭自己的进程并删除自己的临时配置和合成数据库，不操作现有业务实例。不调用方舟或收费接口。

默认查找项目 `.venv-semantica`；可用 `SEMANTIC_TEST_PYTHON` 指定已安装 Semantica 的 Python 绝对路径。环境缺失会失败，不会悄悄跳过。测试还断言服务引擎确实为 Semantica，而不是投影回退。

最终结果和未关闭项见[多租户回归报告](../development/MULTITENANT_VALIDATION.md)及[生产待办](../operations/PRODUCTION_TODO_CHECKLIST.md)。
