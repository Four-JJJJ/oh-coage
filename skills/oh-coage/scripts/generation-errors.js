// User-facing copy is separate from technical details and retry decisions.
function safeDetail(value) {
  return String(value || '')
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|authorization|access_token|token|signature|credential)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@');
}

function recoveryHint(error) {
  const context = error.recovery;
  if (!context) return '';
  const record = context.path ? `\n本次记录：${context.path}` : '';
  if (context.images > 0) return `\n可以继续保存图片，无需重新生成。${record}\n恢复方式：generate.js --resume <本次记录路径>，可用 --out-dir 指定保存目录。`;
  if (context.taskId && !error.terminalTask) return `\n可以稍后继续查询原任务，不会重复生成。${record}\n恢复方式：generate.js --resume <本次记录路径>。`;
  if (error.stage === 'submit' && !error.definitelyRejected) return `\n本次没有可查询的任务编号或图片结果，请先核对服务记录，再决定是否重新生成。${record}`;
  return record;
}

function userMessage(error, classification = {}) {
  const detail = String(error.message || '');
  const kind = error.kind || classification.kind;
  const preflight = error.stage === 'preflight';
  let message;
  if (kind === 'quota') message = '服务提示余额或额度不足，请到服务站点核对账户状态后再试。';
  else if (kind === 'auth') message = '服务未通过密钥验证，请检查 API Key 是否有效，或更新密钥后重试。';
  else if (kind === 'permission') message = '当前账户没有完成这次请求的权限，请到服务站点检查账户状态和访问权限。';
  else if (kind === 'content') message = '服务未接受这次创作内容。你可以调整描述后再试。';
  else if (kind === 'keychain' || /Keychain|钥匙串/i.test(detail)) message = /could not be found|没有找到对应记录/.test(detail)
    ? '这台设备还没有保存此服务的 API Key，请重新连接一次。'
    : '暂时无法读取 API Key。请解锁钥匙串，并在系统提示中允许访问后重试。';
  else if (kind === 'interface') message = '这个模型与当前请求协议不匹配，请调整连接协议或选择兼容的模型。';
  else if (kind === 'budget') message = '本次已达到生成尝试上限，已停止继续提交。可以查看已尝试的模型和结果，再决定是否继续。';
  else if (kind === 'task_timeout') message = '这次生成等待较久，已暂停本地查询。任务可能仍在运行，可以稍后继续查询。';
  else if (kind === 'task_failed') message = `服务返回这次任务未完成：${safeDetail(detail)}。请处理后再试。`;
  else if (kind === 'task_empty') message = '服务显示任务已完成，但没有返回可用图片。请先核对服务端结果。';
  else if (kind === 'resume' || (error.stage === 'resume' && /原配置已变更|恢复记录/.test(detail))) message = '暂时无法恢复这次任务，请检查本次记录及原服务连接后继续。';
  else if (kind === 'no_recovery') message = '本次没有可查询的任务编号或图片结果，请先核对服务记录，再决定是否重新生成。';
  else if (/不是有效图片|base64 图片格式不合法/.test(detail)) message = '服务返回的内容不是有效图片，暂时无法展示。已保留本次记录，供检查原任务结果。';
  else if (kind === 'download' || error.recovery?.images > 0) message = /ENOSPC|EACCES|EROFS|ENOTDIR|EPERM/.test(detail)
    ? '已收到图片结果，但保存失败。请更换保存位置或释放空间，再继续保存。'
    : '已收到图片结果，但暂时无法保存到本地。可以继续下载，无需重新生成。';
  else if (error.generationAccepted) message = '任务已提交，暂时无法获取最新进度。已暂停本地查询，不会重复生成。';
  else if (kind === 'rate_limit') message = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
    ? `当前请求较多，服务建议等待 ${Math.ceil(error.retryAfterMs / 1000)} 秒后再试。`
    : '当前请求较多，服务暂时限制了请求，请稍后再试。';
  else if (kind === 'tls') message = '与生图服务的安全连接未能建立，请稍后重试；若持续出现，请检查网络或联系服务方。';
  else if (kind === 'network') message = classification.resubmittable
    ? '暂时连接不上生图服务，请检查网络和服务地址后重试。'
    : '连接中断，暂时无法确认这次是否已生成或计费。已暂停重复提交，请先核对服务记录。';
  else if (kind === 'upstream') message = '生图服务暂时异常，未收到可用图片。这次的处理和计费结果尚未确认，已暂停重复提交。';
  else if (kind === 'response') message = '服务返回了异常结果，暂时无法取得图片。已保留本次记录，请核对服务端任务状态。';
  else if (kind === 'model') message = error.modelsExhausted
    ? '当前主备模型都未能完成生成，请更换模型后再试。'
    : '当前模型暂不可用，请更换模型，或在模型配置中设置备选后再试。';
  else if (/对应多个|匹配到多个|多个模型族中同名/.test(detail)) message = '这个名称对应多个模型，请从候选列表中选择这次要使用的一个。';
  else if (/未知模型|当前站点列表中没有模型|未在此配置的当前模型列表/.test(detail)) message = '当前服务的模型列表中没有找到这个模型。可以刷新列表，或选择其他模型。';
  else if (/主模型|厂家.*未配置/.test(detail)) message = '还没有为所选厂家设置主模型，选好一个就能开始。';
  else if (/配置.*已停用|profile 不存在|没有可用的 profile/.test(detail)) message = '当前配置暂不可用，请选择其他配置，或重新连接服务。';
  else if (/JSON|配置.*损坏|读取.*配置/i.test(detail) && error.stage !== 'submit') message = '暂时无法读取生图配置。已有文件已保留，可以修复配置或重新连接服务。';
  else if (preflight && /ENOSPC|EACCES|EROFS|ENOTDIR|EPERM/.test(detail)) message = '图片保存位置暂时不可用，请选择可写目录或释放空间后继续。';
  else if (preflight && /图片文件|参考图|image.url|multipart|data URI|ENOENT/i.test(detail)) message = '暂时无法使用这张参考图，请检查图片文件、格式和连接的参考图设置后再试。';
  else if (kind === 'parameters' || preflight) message = '当前请求的参数或设置暂不可用，请根据具体问题调整后再生成。';
  else message = '这次未能取得图片，原因暂未识别。可以查看详情后继续排查。';
  if (preflight) message += '此次未提交生成请求。';
  return message;
}

function formatGenerationError(error, classification) {
  const message = userMessage(error, classification);
  const saved = Object.values(error.recovery?.saved || {}).filter(Boolean);
  return `${message}${saved.length ? `\n已保存图片已保留：${saved.join('、')}` : ''}${recoveryHint(error)}\n技术详情：${safeDetail(error.message)}`;
}

module.exports = { safeDetail, recoveryHint, userMessage, formatGenerationError };
