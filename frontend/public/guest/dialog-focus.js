/* Keep keyboard navigation inside the top reference-demo dialog. */
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Tab') return;
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(function (element) { return element.getClientRects().length && !element.classList.contains('closing'); });
  var dialog = dialogs[dialogs.length - 1];
  if (!dialog) return;
  var items = Array.from(dialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(function (element) { return element.getClientRects().length; });
  var first = items[0]; var last = items[items.length - 1];
  if (!first) { event.preventDefault(); dialog.tabIndex = -1; dialog.focus(); }
  else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
}, true);
