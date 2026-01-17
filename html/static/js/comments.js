// Handle comment reply expansion
document.querySelectorAll('.comment-reply-count').forEach(replyCountEl => {
	replyCountEl.addEventListener('click', async (e) => {
		e.preventDefault();
		e.stopPropagation();

		const continuation = replyCountEl.dataset.continuation;
		const videoId = replyCountEl.dataset.videoId;
		const commentItem = replyCountEl.closest('.comment-item');
		const repliesContainer = commentItem.querySelector('.comment-replies-container');

		if (!repliesContainer) return; // defensive check

		// Toggle if already visible
		if (repliesContainer.style.display !== 'none') {
			repliesContainer.style.display = 'none';
			return;
		}

		// If already has content, just show it
		if (repliesContainer.innerHTML && !repliesContainer.classList.contains('error')) {
			repliesContainer.style.display = 'block';
			return;
		}

		if (!continuation) {
			repliesContainer.innerHTML = '<div class="no-replies" style="padding: 12px; color: #999; font-size: 0.9em;">No replies available</div>';
			repliesContainer.style.display = 'block';
			return;
		}

		// Set loading state
		replyCountEl.textContent = 'Loading...';
		replyCountEl.style.pointerEvents = 'none';
		replyCountEl.style.opacity = '0.6';

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

			const response = await fetch(
				`/api/comments?v=${encodeURIComponent(videoId)}&continuation=${encodeURIComponent(continuation)}`,
				{ signal: controller.signal }
			);

			clearTimeout(timeoutId);

			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = await response.json();

			if (!data || !Array.isArray(data.comments) || data.comments.length === 0) {
				repliesContainer.innerHTML = '<div class="no-replies" style="padding: 12px; color: #999; font-size: 0.9em;">No replies available</div>';
				repliesContainer.style.display = 'block';
				repliesContainer.classList.remove('error'); // clear error state
				return;
			}

			// Build HTML for replies
			let repliesHTML = '<div class="nested-comments" style="margin-top: 12px; margin-left: 16px; padding-left: 12px; border-left: 2px solid #ccc;">';

			data.comments.forEach(reply => {
				repliesHTML += `
					<div class="nested-comment-item" style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
						<div class="nested-comment-author-info" style="display: flex; gap: 8px; align-items: center; margin-bottom: 4px;">
							<a href="${reply.authorUrl}" class="nested-comment-author" style="font-weight: bold; text-decoration: none; color: inherit;">${escapeHtml(reply.author)}</a>
							${reply.verified ? '<span class="nested-comment-verified" style="color: #4a90e2; font-size: 0.9em;">✓</span>' : ''}
							<span class="nested-comment-time" style="font-size: 0.85em; color: #666;">${reply.publishedText}</span>
						</div>
						<div class="nested-comment-text" style="margin: 4px 0; word-wrap: break-word; color: inherit;">${reply.contentHtml}</div>
						${reply.likeCount ? `<div class="nested-comment-likes" style="font-size: 0.85em; color: #666; margin-top: 4px;">👍 ${reply.likeCount}</div>` : ''}
					</div>
				`;
			});

			repliesHTML += '</div>';
			repliesContainer.innerHTML = repliesHTML;
			repliesContainer.style.display = 'block';
			repliesContainer.classList.remove('error');

		} catch (err) {
			console.error('Failed to load replies:', err);
			repliesContainer.innerHTML = '<div class="error-replies" style="padding: 12px; color: #e74c3c; font-size: 0.9em;">Failed to load replies. Click to retry.</div>';
			repliesContainer.style.display = 'block';
			repliesContainer.classList.add('error'); // mark as error
		} finally {
			// Restore button so it can be clicked again
			const replyCount = parseInt(replyCountEl.dataset.replyCount) || 1;
			const plural = replyCount === 1 ? 'reply' : 'replies';
			replyCountEl.textContent = `${replyCount} ${plural}`;
			replyCountEl.style.pointerEvents = 'auto';
			replyCountEl.style.opacity = '1';
		}
	});
});

// Helper function to escape HTML
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}
