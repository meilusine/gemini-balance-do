import { jsx } from 'hono/jsx';

export const Render = () => {
	return (
		<html>
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Gemini API 密钥管理</title>
				<script src="https://cdn.tailwindcss.com"></script>
			</head>
			<body class="bg-gray-100">
				<div class="flex h-screen">
					<div class="w-64 bg-gray-800 text-white p-4">
						<h1 class="text-2xl font-bold mb-8">管理面板</h1>
						<nav>
							<a href="#" class="block py-2 px-4 rounded bg-gray-700">
								密钥管理
							</a>
						</nav>
					</div>
					<div class="flex-1 p-8">
						<h2 class="text-3xl font-bold mb-6">Gemini API 密钥管理</h2>
						<div class="grid grid-cols-1 md:grid-cols-2 gap-8">
							<div class="bg-white p-6 rounded-lg shadow-md">
								<h3 class="text-xl font-semibold mb-4">批量添加密钥</h3>
								<form id="add-keys-form">
									<textarea
										id="api-keys"
										class="w-full h-40 p-2 border rounded bg-gray-50"
										placeholder="请输入API密钥，每行一个"
									></textarea>
									<button type="submit" class="mt-4 w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition">
										添加密钥
									</button>
								</form>
							</div>
							<div class="bg-white p-6 rounded-lg shadow-md">
								<div class="flex justify-between items-center mb-4">
									<h3 class="text-xl font-semibold">已存储的密钥</h3>
									<div>
										<button id="check-keys-btn" class="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition mr-2">
											一键检查
										</button>
										<button id="refresh-keys-btn" class="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition">
											刷新
										</button>
									</div>
								</div>
								<div class="max-h-60 overflow-y-auto">
									<table id="keys-table" class="w-full text-left">
										<thead>
											<tr class="border-b">
												<th class="p-2 w-6">
													<input type="checkbox" id="select-all-keys" />
												</th>
												<th class="p-2">API 密钥</th>
												<th class="p-2">状态</th>
											</tr>
										</thead>
										<tbody></tbody>
									</table>
								</div>
								<button
									id="delete-selected-keys-btn"
									class="mt-4 w-full px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition hidden"
								>
									删除选中
								</button>
							</div>
						</div>
					</div>
				</div>

				<script
					dangerouslySetInnerHTML={{
						__html: `
								document.addEventListener('DOMContentLoaded', () => {
										const addKeysForm = document.getElementById('add-keys-form');
										const apiKeysTextarea = document.getElementById('api-keys');
										const refreshKeysBtn = document.getElementById('refresh-keys-btn');
										const keysTableBody = document.querySelector('#keys-table tbody');
										const selectAllCheckbox = document.getElementById('select-all-keys');
										const deleteSelectedBtn = document.getElementById('delete-selected-keys-btn');
										const checkKeysBtn = document.getElementById('check-keys-btn');

										const fetchAndRenderKeys = async () => {
												keysTableBody.innerHTML = '<tr><td colspan="3" class="p-2 text-center">加载中...</td></tr>';
												try {
												  const response = await fetch('/api/keys');
												  const { keys } = await response.json();
												  keysTableBody.innerHTML = '';
												  if (keys.length === 0) {
												    keysTableBody.innerHTML = '<tr><td colspan="3" class="p-2 text-center">暂无密钥</td></tr>';
												  } else {
												    keys.forEach(key => {
												      const row = document.createElement('tr');
															row.dataset.key = key;
												      row.innerHTML = \`
												        <td class="p-2 w-6"><input type="checkbox" class="key-checkbox" data-key="\${key}" /></td>
												        <td class="p-2 font-mono">\${key}</td>
												        <td class="p-2 status-cell">未知</td>
												      \`;
												      keysTableBody.appendChild(row);
												    });
												  }
												} catch (error) {
												  keysTableBody.innerHTML = '<tr><td colspan="3" class="p-2 text-center text-red-500">加载失败</td></tr>';
												  console.error('Failed to fetch keys:', error);
												}
										};

										const updateDeleteButtonVisibility = () => {
												const selectedKeys = document.querySelectorAll('.key-checkbox:checked');
												deleteSelectedBtn.classList.toggle('hidden', selectedKeys.length === 0);
										};

										keysTableBody.addEventListener('change', (e) => {
												if (e.target.classList.contains('key-checkbox')) {
												  updateDeleteButtonVisibility();
												}
										});

										selectAllCheckbox.addEventListener('change', () => {
												const checkboxes = document.querySelectorAll('.key-checkbox');
												checkboxes.forEach(checkbox => {
												  checkbox.checked = selectAllCheckbox.checked;
												});
												updateDeleteButtonVisibility();
										});

										deleteSelectedBtn.addEventListener('click', async () => {
												const selectedKeys = Array.from(document.querySelectorAll('.key-checkbox:checked')).map(cb => cb.dataset.key);
												if (selectedKeys.length === 0) {
												  alert('请至少选择一个密钥。');
												  return;
												}

												if (!confirm(\`确定要删除选中的 \${selectedKeys.length} 个密钥吗？\`)) {
												  return;
												}

												try {
												  const response = await fetch('/api/keys', {
												    method: 'DELETE',
												    headers: { 'Content-Type': 'application/json' },
												    body: JSON.stringify({ keys: selectedKeys }),
												  });
												  const result = await response.json();
												  if (response.ok) {
												    alert(result.message || '密钥删除成功。');
												    fetchAndRenderKeys();
												    updateDeleteButtonVisibility();
												    selectAllCheckbox.checked = false;
												  } else {
												    alert(\`删除密钥失败: \${result.error || '未知错误'}\`);
												  }
												} catch (error) {
												  alert('请求失败，请检查网络连接。');
												  console.error('Failed to delete keys:', error);
												}
										});

										checkKeysBtn.addEventListener('click', async () => {
											const rows = keysTableBody.querySelectorAll('tr');
											rows.forEach(row => {
												const statusCell = row.querySelector('.status-cell');
												if (statusCell) {
													statusCell.textContent = '检查中...';
													statusCell.className = 'p-2 status-cell text-gray-500';
												}
											});

											try {
												const response = await fetch('/api/keys/check');
												const results = await response.json();
												results.forEach(result => {
													const row = keysTableBody.querySelector(\`tr[data-key="\${result.key}"]\`);
													if (row) {
														const statusCell = row.querySelector('.status-cell');
														if (statusCell) {
															statusCell.textContent = result.valid ? '有效' : '无效';
															statusCell.className = result.valid ? 'p-2 status-cell text-green-500' : 'p-2 status-cell text-red-500';
														}
													}
												});
											} catch (error) {
												alert('检查密钥失败，请查看控制台获取更多信息。');
												console.error('Failed to check keys:', error);
											}
										});

										addKeysForm.addEventListener('submit', async (e) => {
												e.preventDefault();
												const keys = apiKeysTextarea.value.split('\\n').map(k => k.trim()).filter(k => k !== '');
												if (keys.length === 0) {
												  alert('请输入至少一个API密钥。');
												  return;
												}
												try {
												  const response = await fetch('/api/keys', {
												    method: 'POST',
												    headers: { 'Content-Type': 'application/json' },
												    body: JSON.stringify({ keys }),
												  });
												  const result = await response.json();
												  if (response.ok) {
												    alert(result.message || '密钥添加成功。');
												    apiKeysTextarea.value = '';
												    fetchAndRenderKeys();
												  } else {
												    alert(\`添加密钥失败: \${result.error || '未知错误'}\`);
												  }
												} catch (error) {
												  alert('请求失败，请检查网络连接。');
												  console.error('Failed to add keys:', error);
												}
										});

										refreshKeysBtn.addEventListener('click', fetchAndRenderKeys);

										// Initial load
										fetchAndRenderKeys();
								});
				  `,
					}}
				></script>
			</body>
		</html>
	);
};

export const RenderLogin = (error?: string) => {
	return (
		<html>
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Gemini 管理面板登录</title>
				<script src="https://cdn.tailwindcss.com"></script>
			</head>
			<body class="min-h-screen bg-gray-100 flex items-center justify-center p-4">
				<form method="post" action="/" class="w-full max-w-sm bg-white rounded-lg shadow-md p-6">
					<h1 class="text-2xl font-bold mb-5">管理面板登录</h1>
					{error ? <p class="mb-4 text-red-600">{error}</p> : null}
					<label class="block mb-2 font-medium" for="key">管理密码</label>
					<input id="key" name="key" type="password" required autocomplete="current-password" class="w-full p-2 border rounded mb-4" />
					<button type="submit" class="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">登录</button>
				</form>
			</body>
		</html>
	);
};
