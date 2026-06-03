# 钉钉 MCP 工具分类明细

本文档记录钉钉上游 15 个 MCP server 的工具按"业务域分组 + 危险隔离"的完整分类，
作为分组聚合网关（`src/mcp/aggregator.ts`）的权威参照。

- 数据来源：实际探测 `mcp-gw.dingtalk.com/server/{name}` 的 `tools/list`
- 工具总数：**316**（安全 284 + 危险 32）
- 危险判定：工具名（去 `batch_` 前缀后）以 `delete` / `remove` / `revoke` / `reject` 开头
- 工具命名：聚合后统一加 `<server>__<tool>` 前缀

---

## 一、分组总览

| 分组 | endpoint | 模式 | 包含 server | 工具数 |
|------|----------|------|-------------|--------|
| 办公协作 | `/mcp/office` | safe | contact, calendar, todo, report | 58 |
| 文档知识 | `/mcp/docs` | safe | doc, wiki, drive | 45 |
| 表格数据 | `/mcp/tables` | safe | aitable, sheet | 92 |
| 沟通审批 | `/mcp/comm` | safe | oa, mail, bot, group, live, teambition | 89 |
| ⚠️ 危险操作 | `/mcp/danger` | danger | 以上全部 server | 32 |

> safe 组仅含非危险工具（查询/新增/更新）；danger 组仅含删除/移除/撤销/驳回类工具。
> 每组工具数均 < 100，满足 Amazon Quick 单连接器上限。

---

## 二、各 server 安全/危险统计

| server | 业务分组 | 总数 | 安全 | 危险 |
|--------|----------|------|------|------|
| contact 通讯录 | office | 12 | 12 | 0 |
| calendar 日历 | office | 26 | 22 | 4 |
| todo 待办 | office | 19 | 15 | 4 |
| report 日志 | office | 9 | 9 | 0 |
| doc 文档 | docs | 29 | 26 | 3 |
| wiki 知识库 | docs | 11 | 9 | 2 |
| drive 钉盘 | docs | 10 | 10 | 0 |
| aitable AI表格 | tables | 53 | 45 | 8 |
| sheet 在线表格 | tables | 54 | 47 | 7 |
| oa OA审批 | comm | 21 | 19 | 2 |
| mail 邮箱 | comm | 24 | 23 | 1 |
| bot 机器人 | comm | 14 | 13 | 1 |
| group 群聊 | comm | 3 | 3 | 0 |
| live 直播 | comm | 3 | 3 | 0 |
| teambition 项目管理 | comm | 28 | 28 | 0 |
| **合计** | | **316** | **284** | **32** |

---

## 三、危险操作清单（共 32 个，归入 `/mcp/danger`）

这些工具不可逆，AI 助手调用前必须向用户说明操作内容与影响范围并取得确认。

| server | 工具（聚合后前缀名） |
|--------|----------------------|
| calendar | `calendar__delete_acl`、`calendar__delete_calendar_event`、`calendar__delete_meeting_room`、`calendar__remove_calendar_participant` |
| todo | `todo__delete_todo`、`todo__delete_todo_comment`、`todo__remove_task_executors`、`todo__remove_task_participants` |
| doc | `doc__delete_document`、`doc__delete_document_block`、`doc__remove_permission` |
| wiki | `wiki__delete_wikiSpace`、`wiki__remove_member` |
| aitable | `aitable__delete_base`、`aitable__delete_chart`、`aitable__delete_dashboard`、`aitable__delete_field`、`aitable__delete_guide_document`、`aitable__delete_records`、`aitable__delete_table`、`aitable__delete_view` |
| sheet | `sheet__delete_cond_format`、`sheet__delete_dimension`、`sheet__delete_dropdown_lists`、`sheet__delete_filter`、`sheet__delete_filter_view`、`sheet__delete_float_image`、`sheet__delete_sheet` |
| oa | `oa__reject_processInstance`、`oa__revoke_processInstance` |
| mail | `mail__batch_delete_message` |
| bot | `bot__remove_robot_in_group` |

> contact、report、drive、group、live、teambition 这 6 个 server 无危险操作。

---

## 四、各分组安全工具明细

### office 办公协作（58）

- **contact 通讯录（12）**：get_current_user_profile、get_dept_info_by_dept_id、get_dept_members_by_deptId、get_sub_depts_by_dept_id、get_user_info_by_user_ids、list_my_followings、search_contact_by_key_word、search_dept_by_keyword、search_user_by_key_word、search_user_by_mobile（及其余查询类）
- **calendar 日历（22）**：list_calendars、list_calendar_events、create_calendar_event、update_calendar_event、get_calendar、get_calendar_detail、add_calendar_participant、query_busy_status、search_calendar、respond 等（不含 4 个删除类）
- **todo 待办（15）**：create_personal_todo、create_personal_sub_todo、get_todo_detail、get_user_todos_in_current_org、update_todo_task、update_todo_done_status、add_task_executors、add_task_participants、add_todo_comment、add_todo_reminder 等（不含 4 个删除类）
- **report 日志（9）**：create_report、get_available_report_templates、get_received_report_list、get_report_entry_details、get_report_statistics_by_id、get_send_report_list、get_template_details_by_name 等

### docs 文档知识（45）

- **doc 文档（26）**：create_document、create_file、create_folder、get_document_content、get_document_info、list_document_blocks、list_nodes、search_documents、update_document、update_document_block、add_permission、list_permission、copy_document、move_document、rename_document、download_file、submit_export_job、query_export_job 等（不含 3 个删除类）
- **wiki 知识库（9）**：create_wikiSpace、get_wikiSpace、list_wikiSpaces、search_wikiSpaces、update_member、add_member、list_member 等（不含 2 个删除类）
- **drive 钉盘（10）**：commit_upload、create_folder、download_file、get_file_info、get_upload_info、list_files、list_spaces、search_files 等

### tables 表格数据（92）

- **aitable AI表格（45）**：create_base、create_table、create_view、create_fields、create_records、create_chart、create_dashboard、query_records、get_base、get_tables、get_views、get_fields、list_bases、search_bases、import_data、export_data、update_base、update_table、update_view、update_field、update_records、update_chart、update_dashboard、run_ai_field、run_datasource_sync 等（不含 8 个删除类）
- **sheet 在线表格（47）**：create_sheet、create_workspace_sheet、create_filter、create_filter_view、create_cond_format、create_float_image、append_rows、get_range、get_sheet、get_all_sheets、find_cells、replace_all、fill_range、copy_range、copy_sheet、move_range、merge_cells、unmerge_range、sort_range、insert_dimension、add_dimension、move_dimension、update_range、update_sheet、write_image、submit_export_job、query_export_job 等（不含 7 个删除类）

### comm 沟通审批（89）

- **oa OA审批（19）**：list_pending_approvals、list_pending_approvals_for_me、list_pending_tasks、get_todo_tasks、get_done_tasks、get_processInstances、get_processInstance_detail、get_processInstance_records、get_submitted_instances、get_noticed_instances、list_initiated_instances、list_user_visible_process、approve_processInstance、append_task、redirect_task、dingflow_comments、oa_cc_noticer 等（不含 reject/revoke 2 个）
- **mail 邮箱（23）**：list_user_mailboxes、list_folders、list_tags、list_mail_attachments、search_emails、search_mail_users、get_email_by_message_id、get_thread、send_email、send_draft、create_draft、create_reply_draft、create_replyall_draft、create_forward_draft、reply_message、reply_all、forward_message、update_draft、batch_move_message、create_upload_session、create_download_session 等（不含 batch_delete_message）
- **bot 机器人（13）**：create_robot、add_robot_to_group、list_group_bots、search_bots、search_my_robots、search_groups_by_keyword、send_message_by_custom_robot、send_robot_group_message、batch_send_robot_msg_to_users、recall_robot_group_message、batch_recall_robot_users_msg 等（不含 remove_robot_in_group）
- **group 群聊（3）**：create_internal_org_group 等
- **live 直播（3）**：get_my_lives 等
- **teambition 项目管理（28）**：create_project、create_task、create_task_progress、create_actual_work_hour_record、get_task_detail、get_task_progress、get_user_projects、get_project_member_list、get_project_task_types、list_projects、search_task_ids_by_tql、search_project_workflow_status、add_project_members、add_task_comment、assign_task_assignees、set_task_due_date、set_task_start_time、update_task_status、update_task_title、update_task_priority、update_task_remark、update_project_info、update_actual_work_hour_record 等（无删除类）

---

## 五、维护说明

- 分组定义在 `src/mcp/aggregator.ts` 的 `GROUPS` 常量。
- 危险动词在同文件 `DANGER_VERBS`（当前：delete / remove / revoke / reject）。
- 钉钉上游若新增工具，会自动归类（按动词），但需留意 tables / comm 组已接近 100 上限。
- 工具明细基于探测时的快照，钉钉更新工具后以实际 `tools/list` 为准。
