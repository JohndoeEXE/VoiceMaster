const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store temporary VCs and their data
const tempChannels = new Map(); // channelId -> { ownerId, rejectedUsers: Set(), locked: boolean, permittedUsers: Set() }
const JOIN_TO_CREATE_NAME = "JTC";

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

// Handle voice state updates (joining/leaving voice channels)
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        // User joined a voice channel
        if (!oldState.channelId && newState.channelId) {
            const channel = newState.channel;
            
            // Check if they joined the "Join To Create" channel
            if (channel && channel.name === JOIN_TO_CREATE_NAME) {
                await createTempChannel(newState.member, channel);
            }
        }
        
        // User left a voice channel
        if (oldState.channelId && !newState.channelId) {
            const leftChannel = oldState.channel;
            
            // Check if it's a temp channel and if it's empty
            if (leftChannel && tempChannels.has(leftChannel.id)) {
                if (leftChannel.members.size === 0) {
                    await deleteTempChannel(leftChannel.id);
                }
            }
        }
        
        // User switched channels
        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            const leftChannel = oldState.channel;
            const joinedChannel = newState.channel;
            
            // Check if they joined "Join To Create"
            if (joinedChannel && joinedChannel.name === JOIN_TO_CREATE_NAME) {
                await createTempChannel(newState.member, joinedChannel);
            }
            
            // Check if they left a temp channel and it's now empty
            if (leftChannel && tempChannels.has(leftChannel.id)) {
                if (leftChannel.members.size === 0) {
                    await deleteTempChannel(leftChannel.id);
                }
            }
            
            // Check if they're trying to join a locked temp channel
            if (joinedChannel && tempChannels.has(joinedChannel.id)) {
                const channelData = tempChannels.get(joinedChannel.id);
                if (channelData.locked && !channelData.permittedUsers.has(newState.member.id) && channelData.ownerId !== newState.member.id) {
                    // Disconnect them from the locked channel
                    await newState.member.voice.disconnect('Channel is locked');
                    try {
                        await newState.member.send('❌ That voice channel is locked. You need permission from the owner to join.');
                    } catch (e) {
                        console.log('Could not DM user about locked channel');
                    }
                    return;
                }
                
                // Check if they're rejected
                if (channelData.rejectedUsers.has(newState.member.id)) {
                    await newState.member.voice.disconnect('You have been rejected from this channel');
                    try {
                        await newState.member.send('❌ You have been rejected from that voice channel.');
                    } catch (e) {
                        console.log('Could not DM user about rejection');
                    }
                    return;
                }
            }
        }
    } catch (error) {
        console.error('Error in voiceStateUpdate:', error);
    }
});

// Handle messages for commands
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(',vc')) return;
    
    const args = message.content.slice(3).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    // Check if user is in a voice channel
    const member = message.member;
    if (!member.voice.channelId) {
        return message.reply('❌ You need to be in a voice channel to use voice commands.');
    }
    
    const voiceChannel = member.voice.channel;
    const channelData = tempChannels.get(voiceChannel.id);
    
    // Check if it's a temp channel
    if (!channelData) {
        return message.reply('❌ This command can only be used in temporary voice channels.');
    }
    
    // Check if user is the owner
    if (channelData.ownerId !== member.id) {
        return message.reply('❌ Only the channel owner can use this command.');
    }
    
    switch (command) {
        case 'reject':
            await handleRejectCommand(message, args, voiceChannel, channelData);
            break;
        case 'lock':
            await handleLockCommand(message, voiceChannel, channelData);
            break;
        case 'permit':
            await handlePermitCommand(message, args, voiceChannel, channelData);
            break;
        case 'transfer':
            await handleTransferCommand(message, args, voiceChannel, channelData);
            break;
        default:
            message.reply('❌ Unknown command. Available commands: `reject`, `lock`, `permit`, `transfer`');
    }
});

async function createTempChannel(member, joinToCreateChannel) {
    try {
        const guild = member.guild;
        const category = joinToCreateChannel.parent;
        
        // Create new temp channel
        const tempChannel = await guild.channels.create({
            name: `${member.displayName}'s Channel`,
            type: ChannelType.GuildVoice,
            parent: category,
            permissionOverwrites: [
                {
                    id: member.id,
                    allow: [
                        PermissionFlagsBits.ManageChannels,
                        PermissionFlagsBits.MoveMembers,
                        PermissionFlagsBits.MuteMembers,
                        PermissionFlagsBits.DeafenMembers
                    ]
                }
            ]
        });
        
        // Store channel data
        tempChannels.set(tempChannel.id, {
            ownerId: member.id,
            rejectedUsers: new Set(),
            locked: false,
            permittedUsers: new Set()
        });
        
        // Move user to the new channel
        await member.voice.setChannel(tempChannel);
        
        console.log(`Created temp channel "${tempChannel.name}" for ${member.displayName}`);
        
    } catch (error) {
        console.error('Error creating temp channel:', error);
    }
}

async function deleteTempChannel(channelId) {
    try {
        const channel = client.channels.cache.get(channelId);
        if (channel) {
            await channel.delete('Temporary channel cleanup');
            tempChannels.delete(channelId);
            console.log(`Deleted empty temp channel`);
        }
    } catch (error) {
        console.error('Error deleting temp channel:', error);
    }
}

async function handleRejectCommand(message, args, voiceChannel, channelData) {
    if (args.length === 0) {
        return message.reply('❌ Please specify a user to reject. Usage: `,vc reject @user` or `,vc reject userId`');
    }
    
    try {
        const target = await getTargetUser(message, args[0]);
        if (!target) {
            return message.reply('❌ User not found.');
        }
        
        if (target.id === message.author.id) {
            return message.reply('❌ You cannot reject yourself.');
        }
        
        // Add to rejected users
        channelData.rejectedUsers.add(target.id);
        
        // Remove from permitted users if they were there
        channelData.permittedUsers.delete(target.id);
        
        // Kick them if they're in the channel
        if (target.voice.channelId === voiceChannel.id) {
            await target.voice.disconnect('Rejected from voice channel');
        }
        
        message.reply(`✅ ${target.displayName} has been rejected from this channel.`);
        
    } catch (error) {
        console.error('Error in reject command:', error);
        message.reply('❌ An error occurred while rejecting the user.');
    }
}

async function handleLockCommand(message, voiceChannel, channelData) {
    try {
        channelData.locked = !channelData.locked;
        
        if (channelData.locked) {
            message.reply('🔒 Channel has been locked. Only permitted users can join now.');
        } else {
            message.reply('🔓 Channel has been unlocked. Anyone can join now.');
        }
        
    } catch (error) {
        console.error('Error in lock command:', error);
        message.reply('❌ An error occurred while toggling the lock.');
    }
}

async function handlePermitCommand(message, args, voiceChannel, channelData) {
    if (args.length === 0) {
        return message.reply('❌ Please specify a user to permit. Usage: `,vc permit @user` or `,vc permit userId`');
    }
    
    try {
        const target = await getTargetUser(message, args[0]);
        if (!target) {
            return message.reply('❌ User not found.');
        }
        
        // Add to permitted users
        channelData.permittedUsers.add(target.id);
        
        // Remove from rejected users if they were there
        channelData.rejectedUsers.delete(target.id);
        
        message.reply(`✅ ${target.displayName} has been permitted to join this channel.`);
        
    } catch (error) {
        console.error('Error in permit command:', error);
        message.reply('❌ An error occurred while permitting the user.');
    }
}

async function handleTransferCommand(message, args, voiceChannel, channelData) {
    if (args.length === 0) {
        return message.reply('❌ Please specify a user to transfer ownership to. Usage: `,vc transfer @user` or `,vc transfer userId`');
    }
    
    try {
        const target = await getTargetUser(message, args[0]);
        if (!target) {
            return message.reply('❌ User not found.');
        }
        
        if (target.id === message.author.id) {
            return message.reply('❌ You cannot transfer ownership to yourself.');
        }
        
        if (target.voice.channelId !== voiceChannel.id) {
            return message.reply('❌ The target user must be in the voice channel to receive ownership.');
        }
        
        // Transfer ownership
        channelData.ownerId = target.id;
        
        // Update channel permissions
        await voiceChannel.permissionOverwrites.edit(message.author.id, {
            ManageChannels: null,
            MoveMembers: null,
            MuteMembers: null,
            DeafenMembers: null
        });
        
        await voiceChannel.permissionOverwrites.edit(target.id, {
            ManageChannels: true,
            MoveMembers: true,
            MuteMembers: true,
            DeafenMembers: true
        });
        
        // Rename channel
        await voiceChannel.setName(`${target.displayName}'s Channel`);
        
        message.reply(`✅ Channel ownership has been transferred to ${target.displayName}.`);
        
    } catch (error) {
        console.error('Error in transfer command:', error);
        message.reply('❌ An error occurred while transferring ownership.');
    }
}

async function getTargetUser(message, input) {
    // Check if it's a mention
    const mentionMatch = input.match(/^<@!?(\d+)>$/);
    if (mentionMatch) {
        return await message.guild.members.fetch(mentionMatch[1]).catch(() => null);
    }
    
    // Check if it's a user ID
    if (/^\d+$/.test(input)) {
        return await message.guild.members.fetch(input).catch(() => null);
    }
    
    // Try to find by username/display name
    const members = await message.guild.members.fetch();
    return members.find(member => 
        member.user.username.toLowerCase() === input.toLowerCase() ||
        member.displayName.toLowerCase() === input.toLowerCase()
    ) || null;
}

// Login with bot token from environment variable
client.login(process.env.DISCORD_TOKEN);
