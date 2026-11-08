const { withGradleProperties } = require("@expo/config-plugins");

module.exports = function withLowMemoryGradle(config) {
  return withGradleProperties(config, (config) => {
    const properties = config.modResults;
    const maxHeap = properties.find(
      (item) => item.type === "property" && item.key === "org.gradle.jvmargs",
    );
    if (maxHeap) {
      maxHeap.value = "-Xms64m -Xmx512m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC";
    } else {
      properties.push({
        type: "property",
        key: "org.gradle.jvmargs",
        value: "-Xms64m -Xmx512m -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC",
      });
    }

    const maxWorkers = properties.find(
      (item) => item.type === "property" && item.key === "org.gradle.workers.max",
    );
    if (maxWorkers) maxWorkers.value = "1";
    else properties.push({ type: "property", key: "org.gradle.workers.max", value: "1" });

    return config;
  });
};
