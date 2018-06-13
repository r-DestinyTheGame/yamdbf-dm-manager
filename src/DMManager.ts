import { Message, Guild, User, TextChannel, DMChannel, Collection, MessageEmbed } from 'discord.js';
import { GuildStorage, ClientStorage, Client, Plugin, IPlugin, PluginConstructor } from '@yamdbf/core';
import { normalize } from './Util';
import { dmManagerFactory } from './dmManagerFactory';
import { DMManagerUsageError } from './DMManagerUsageError';

export class DMManager extends Plugin implements IPlugin
{
	public static readonly default: (guild: string) => PluginConstructor = dmManagerFactory;
	public static readonly dmManager: (guild: string) => PluginConstructor = dmManagerFactory;
	public static readonly DMManager: PluginConstructor = DMManager;

	public readonly name: string = 'DMManager';

	private readonly client: Client;
	private readonly storage: ClientStorage;
	private readonly _guild: string;
	private guild: Guild;
	private channels: Collection<string, TextChannel>;

	public constructor(client: Client, guild: string = '')
	{
		super();
		this.client = client;

		if (!guild) throw new DMManagerUsageError('Import "dmManager" and pass to plugins with a guild ID');
		if (!this.client.guilds.resolve(guild))
			throw new Error(`DMManager: Failed to find guild with ID '${guild}'`);

		this.storage = this.client.storage;
		this._guild = guild;
	}

	public async init(): Promise<void>
	{
		this.guild = this.client.guilds.resolve(this._guild);
		if (await this.storage.exists('plugin.dmManager.guild')
			&& await this.storage.get('plugin.dmManager.guild') !== this._guild)
				await this.clearOpenChannels();

		await this.storage.set('plugin.dmManager.guild', this._guild);

		if (!this.guild.member(this.client.user).permissions.has(['MANAGE_CHANNELS', 'MANAGE_MESSAGES']))
			throw new Error('DMManager: Bot must have MANAGE_CHANNELS, MANAGE_MESSAGES permissions in the supplied guild');

		this.channels = new Collection<string, TextChannel>(
			(await this.storage.get('plugin.dmManager.openChannels') || []).map((c: [string, string]) =>
				[c[0], this.guild.channels.get(c[1])]) || []);

		this.client.on('message', (message: Message) => this.handleMessage(message));
		this.client.on('channelDelete', (channel: TextChannel) =>
		{
			if (this.channels.find((c: TextChannel) => c.id === channel.id))
			{
				this.channels.delete(this.channels.findKey((c: TextChannel) => c.id === channel.id));
				this.storeOpenChannels();
			}
		});

		this.client.on('blacklistAdd', (user, global) => { if (global) this.blacklist(user); });
		this.client.on('blacklistRemove', (user, global) => { if (global) this.whitelist(user); });
	}

	/**
	 * Add a user to the DMManager blacklist
	 */
	public async blacklist(user: User): Promise<void>
	{
		await this.storage.set(`plugin.dmManager.blacklist.${user.id}`, true);
	}

	/**
	 * Remove a user from the DMManager blacklist
	 */
	public async whitelist(user: User): Promise<void>
	{
		await this.storage.remove(`plugin.dmManager.blacklist.${user.id}`);
	}

	/**
	 * Return whether or not a user is blacklisted from the DMManager
	 */
	private async isBlacklisted(user: User): Promise<boolean>
	{
		return await this.storage.exists(`plugin.dmManager.blacklist.${user.id}`);
	}

	/**
	 * Update open managed channels in storage
	 */
	private async storeOpenChannels(): Promise<void>
	{
		await this.storage.set('plugin.dmManager.openChannels',
			Array.from(this.channels.entries())
				.map((c: [string, TextChannel]) => [c[0], c[1].id]));
	}

	/**
	 * Remove any open channels from storage
	 */
	private async clearOpenChannels(): Promise<void>
	{
		await this.storage.set('plugin.dmManager.openChannels', []);
		this.channels.clear();
	}

	/**
	 * Create a new managed channel for the user in the dm manager
	 * guild and add it to the channels cache and stored openChannels
	 */
	private async createNewChannel(user: User): Promise<TextChannel>
	{
		let newChannel: TextChannel;
		try
		{
			newChannel = <TextChannel> await this.guild.channels.create(`${normalize(user.username) || 'unicode'}-${user.discriminator}`,
				{ overwrites: [{id: '336179293954506753', allowed: ['VIEW_CHANNEL', 'SEND_MESSAGES']}]});
			this.channels.set(user.id, newChannel);
			this.storeOpenChannels();
			this.client.logger.info('DMManager', `Created channel. Username: ${user.tag} | ChannelID: ${newChannel.id}`);
		}
		catch (err)
		{
			this.sendError(`DMManager: Failed to create channel: '${normalize(user.username)}-${user.discriminator} (${user.id})'\n${err}`);
			this.client.logger.error('DMManager', `Failed to create channel: '${normalize(user.username)}-${user.discriminator} (${user.id})'\n${err}`);
		}

		if (newChannel) { 
			await this.buildUserInfo(user, newChannel);
		}
		return newChannel;
	}

	/**
	 * Create an embed for user info used at the start
	 * of a new managed channel
	 */
	private async buildUserInfo(user: User, newChannel: TextChannel): Promise<void>
	{
		const storage: GuildStorage = await this.client.storage.guilds.get(config.ServerData.serverId);
		let message: Message;

		// New DM Channel Started
		if (await storage.settings.exists('dm-newchannel') && await storage.settings.get('dm-newchannel')) {
			let userInfoEmbed = new MessageEmbed();
			userInfoEmbed.setColor(8450847);
			userInfoEmbed.setAuthor(`${user.username}#${user.discriminator} (${user.id})`, user.avatarURL());
			userInfoEmbed.setFooter('DM channel started');
			userInfoEmbed.setTimestamp();
			newChannel.send({ embed: userInfoEmbed });
		}

		// New DM Channel - Get userstats
		if (await storage.settings.exists('dm-userstats') && await storage.settings.get('dm-userstats')) {
			await this.client.commands.find(cmd => cmd.name === 'us').action(message, [user.id, newChannel.guild.id, newChannel.id], true);
		}

		// New DM Channel - Get main server history
		if (await storage.settings.exists('dm-history') && await storage.settings.get('dm-history')) {
			await this.client.commands.find(cmd => cmd.name === 'history').action(message, [user.id, newChannel.guild.id, newChannel.id], true);
		}

		return;
	}

	/**
	 * Handle incoming messages. If it's a DM, find the channel
	 * belonging to the user. If it doesn't exist, create one
	 */
	private async handleMessage(message: Message): Promise<void>
	{
		if (await this.isBlacklisted(message.author)) return;
		if (message.embeds[0] && message.channel.type !== 'dm') return;
		if (message.channel.type !== 'dm' && message.guild.id !== this._guild) return;
		if (message.guild && message.channel.id === message.guild.id) return;
		if (message.author.id !== this.client.user.id
			&& !this.channels.has(message.author.id) && !message.guild)
			await this.createNewChannel(message.author);

		// Don't process messages the bot sends in the DM
		if (message.author.id === this.client.user.id) { return; }

		if (message.channel.type === 'dm')
		{
			const channelID: string = message.author.id === this.client.user.id ?
				(<DMChannel> message.channel).recipient.id : message.author.id;
			const channel: TextChannel = this.channels.get(channelID);
			if (!channel) return;
			if (message.embeds[0]) message.content += '\n\n**[MessageEmbed]**';
			await this.send(channel, message, message.author) 
				.catch(err => this.sendError(`Failed to send message in #${this.channels.get(channelID).name}\n${err}`));
		}
		else
		{
			const user: User = await this.fetchUser(<TextChannel> message.channel);
			if (await this.isBlacklisted(user))
			{
				message.channel.send(`This user is blacklisted. No replies will be sent to the user.`);
				return;
			}

			try
			{
				message.delete();
				await user.send(`${message.content}\n\n-${message.member.user.tag}`);

				const channelID: string = user.id;
				const channel: TextChannel = this.channels.get(channelID);
				await this.send(channel, message, user);
			}
			catch (err)
			{
				this.client.logger.error('DMManager', `Error sending message to: '${normalize(user.username)}-${user.discriminator} (${user.id})'\n${err}`);
				message.channel.send(new MessageEmbed()
					.setColor('#FF0000')
					.setTitle('There was an error while sending the message')
					.setDescription(err));
				const codeblock: string = '```';
				message.channel.send(`${codeblock} ${message.content} ${codeblock}`);
			}
		}
	}

	/**
	 * Fetch the user object the managed channel represents contact with
	 */
	private async fetchUser(channel: TextChannel): Promise<User>
	{
		const id: string = this.channels.findKey(chan => chan.id === channel.id);
		return await this.client.users.fetch(id);
	}

	/**
	 * Send a text message to a managed channel as an embed, spoofing
	 * the provided user to simulate messages from that user
	 */
	private async send(channel: TextChannel, message: Message, reciever: User): Promise<Message>
	{
		var embedColor: string;
		var footer: string;
		const user: User = message.author;
		const embed: MessageEmbed = new MessageEmbed();
		if (message.author.id === reciever.id && message.channel.type === 'dm') {
			// Color for incoming messages
			embedColor = '19D219';
			footer = '';
		} else {
			// Color for outgoing messages
			embedColor = '551a8b';
			footer = `\n\n-${message.member.user.tag}`;
		}
		embed.setColor(embedColor);
		embed.setAuthor(`${user.tag} (${user.id})`, user.avatarURL());
		embed.setDescription(message.content + footer);

		if (message.attachments.size !== 0) {
			embed.addField('Attachment:', message.attachments.map(file => file.url));
		}
		embed.setTimestamp();

		return <Message> await channel.send({ embed });
	}

	/**
	 * Send an error to the default channel of the DMManager guild
	 */
	private async sendError(message: string): Promise<Message>
	{
		return <Message> await (<TextChannel> this.guild.channels.first())
			.send({
				embed: new MessageEmbed()
					.setColor('#FF0000')
					.setTitle('DMManager error')
					.setDescription(message)
					.setTimestamp()
			});
	}
}
