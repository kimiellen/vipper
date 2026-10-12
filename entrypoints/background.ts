export default defineBackground(() => {
  chrome.commands.onCommand.addListener((command) => {
    console.log(`[vipper] command received: ${command}`);
  });
});
