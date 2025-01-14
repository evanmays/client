# Interface: SerializedPlugin

[Backend/Plugins/SerializedPlugin](../modules/backend_plugins_serializedplugin.md).SerializedPlugin

Represents a plugin that the user has added to their game. Used
internally for storing plugins. Not used for evaluating plugins!

## Table of contents

### Properties

- [code](backend_plugins_serializedplugin.serializedplugin.md#code)
- [id](backend_plugins_serializedplugin.serializedplugin.md#id)
- [isLocal](backend_plugins_serializedplugin.serializedplugin.md#islocal)
- [lastEdited](backend_plugins_serializedplugin.serializedplugin.md#lastedited)
- [localFilename](backend_plugins_serializedplugin.serializedplugin.md#localfilename)
- [name](backend_plugins_serializedplugin.serializedplugin.md#name)

## Properties

### code

• `Optional` **code**: _string_

This code is a javascript object that complies with the
[PluginProcess](backend_plugins_pluginprocess.pluginprocess.md) interface.

---

### id

• **id**: [_PluginId_](../modules/backend_plugins_serializedplugin.md#pluginid)

Unique ID, assigned at the time the plugin is first saved.

---

### isLocal

• **isLocal**: _boolean_

In development mode, Dark Forest allows you to load plugins into the
game via webpack's HMR. This means you can develop a plugin in VS Code,
hit save, and the plugin will be automatically loaded into the player's
plugin library. We need to keep track of which plugins
are local and which were loaded in by the player manually.

---

### lastEdited

• **lastEdited**: _number_

{@code new Date.getTime()} at the point that this plugin was saved

---

### localFilename

• `Optional` **localFilename**: _string_

---

### name

• **name**: _string_

Shown in the list of plugins.
